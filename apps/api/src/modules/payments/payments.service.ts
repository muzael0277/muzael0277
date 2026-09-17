import { Injectable } from '@nestjs/common';
import {
  getProvider, providerForMethod, PaymentProviderError,
  type NormalizedIntent, type PaymentProviderKey, type ProviderContext, type WebhookRequest,
} from '@bizbot/payments';
import type { GuardedTransactionClient, PaymentState, Prisma } from '@bizbot/database';
import { DomainError, ErrorCode } from '@bizbot/shared';
import { PrismaService } from '../../infra/prisma.service';
import { VaultService } from '../../infra/vault.service';
import { EventBus } from '../events/event-bus.service';
import { DomainEventType } from '../events/event-types';
import { AuditService } from '../audit/audit.service';
import { logger } from '../../common/logger';

/**
 * Payments.
 *
 * Providers translate their protocol into a normalized intent; this service is the only
 * thing that touches the database. Amount verification, replay protection and the state
 * machine are therefore written once and shared by every provider — the place money bugs
 * hide is centralized (docs/adr/0004-provider-adapters.md).
 */

/** A terminal state is final. Re-applying an intent that reaches it is a no-op, not an error. */
const ALLOWED_TRANSITIONS: Record<PaymentState, PaymentState[]> = {
  PENDING: ['PROCESSING', 'PAID', 'FAILED', 'CANCELLED', 'EXPIRED'],
  PROCESSING: ['PAID', 'FAILED', 'CANCELLED', 'EXPIRED'],
  PAID: ['REFUNDED', 'PARTIALLY_REFUNDED'],
  PARTIALLY_REFUNDED: ['REFUNDED'],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
  REFUNDED: [],
};

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: VaultService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
  ) {}

  async createForOrder(orderId: string, method: string, options: { returnUrl?: string; language?: 'uz' | 'ru' | 'en' } = {}) {
    const order = await this.prisma.client.order.findFirstOrThrow({
      where: { id: orderId }, include: { customer: true },
    });

    if (order.paymentStatus === 'PAID') {
      throw new DomainError(ErrorCode.PAYMENT_ALREADY_FINALIZED, 'This order is already paid');
    }

    const providerKey = providerForMethod(method);
    const { provider, ctx, integrationId } = await this.resolveProvider(providerKey, options);

    const payment = await this.prisma.client.payment.create({
      data: {
        orderId: order.id,
        customerId: order.customerId,
        integrationId,
        provider: providerKey,
        method: method as never,
        state: 'PENDING',
        amount: order.total,
        currency: order.currency,
      } as never,
    });

    const result = await provider.createPayment(ctx, {
      paymentId: payment.id,
      amount: order.total,
      currency: order.currency,
      orderId: order.id,
      reference: order.orderNumber,
      description: `Buyurtma ${order.orderNumber}`,
      customerPhone: order.phoneSnapshot ?? order.customer.phone ?? undefined,
    });

    const updated = await this.prisma.client.payment.update({
      where: { id: payment.id },
      data: {
        checkoutUrl: result.checkoutUrl,
        externalId: result.externalId,
        state: result.settledImmediately ? 'PAID' : 'PENDING',
      },
    });

    if (result.settledImmediately) {
      await this.applyIntent(payment.id, {
        kind: 'mark_paid', externalId: result.externalId ?? payment.id,
        amount: order.total, paidAt: new Date(),
      });
    }

    return {
      id: updated.id,
      state: updated.state,
      checkoutUrl: updated.checkoutUrl,
      instructions: result.instructions,
      amount: updated.amount,
    };
  }

  /**
   * The inbound webhook pipeline. Invariant I4: a replay must change nothing.
   *
   * Order matters. Signature first (an unverified payload is not evidence of anything),
   * then deduplication (before any side effect), then one idempotent transition.
   */
  async handleWebhook(
    providerKey: PaymentProviderKey,
    integrationId: string,
    request: WebhookRequest,
  ): Promise<{ status: number; body: unknown }> {
    const integration = await this.prisma.system('payment-webhook-integration', () =>
      this.prisma.raw.integration.findUnique({ where: { id: integrationId } }),
    );
    if (!integration || !integration.isEnabled) {
      return { status: 404, body: { error: 'Integration not found' } };
    }

    const provider = getProvider(providerKey);
    const ctx: ProviderContext = {
      tenantId: integration.tenantId,
      credentials: this.openCredentials(integration),
      config: (integration.config ?? {}) as Record<string, unknown>,
      language: 'uz',
    };

    try {
      await provider.verifyWebhook(ctx, request);
    } catch (error) {
      // A bad signature is a security event, not a validation error.
      await this.audit.record({
        tenantId: integration.tenantId,
        action: 'payment.webhook_signature_invalid',
        entityType: 'INTEGRATION', entityId: integration.id,
        after: { provider: providerKey, reason: error instanceof PaymentProviderError ? error.code : 'UNKNOWN' },
      });
      logger.warn({ provider: providerKey, integrationId }, 'Payment webhook signature rejected');
      return { status: 401, body: { error: 'Invalid signature' } };
    }

    const outcome = await provider.handleWebhook(ctx, request);

    // Deduplicate before touching anything. A unique-constraint violation here means the
    // provider is retrying, and the stored response is replayed verbatim so they see a
    // consistent answer.
    const dedupKey = `${providerKey}:${outcome.idempotencyKey}`;
    const existing = await this.prisma.system('payment-webhook-dedup-read', () =>
      this.prisma.raw.processedWebhook.findUnique({
        where: { source_key: { source: providerKey, key: dedupKey } },
      }),
    );
    if (existing) {
      return { status: outcome.statusCode ?? 200, body: existing.response ?? outcome.response };
    }

    // The dedup row and the state transition commit together. Writing the dedup row
    // first looked equivalent, but it is not: when processing then failed, the event was
    // permanently marked handled and the provider's retry became a no-op — a payment
    // stuck PENDING forever with the customer already charged. Observed directly, hence
    // the transaction.
    try {
      await this.applyIntentWithDedup(
        { source: providerKey, key: dedupKey, tenantId: integration.tenantId, response: outcome.response },
        outcome.paymentId,
        outcome.intent,
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Lost the race with a concurrent delivery of the same event; the other one wins.
        return { status: outcome.statusCode ?? 200, body: outcome.response };
      }
      throw error;
    }

    return { status: outcome.statusCode ?? 200, body: outcome.response };
  }

  /**
   * Records the event as handled and applies its intent atomically.
   *
   * A failure rolls back both, so the provider's retry is a genuine retry rather than a
   * silent no-op.
   */
  private async applyIntentWithDedup(
    dedup: { source: string; key: string; tenantId: string; response: unknown },
    paymentId: string | undefined,
    intent: NormalizedIntent,
  ): Promise<void> {
    const { tenantContext } = await import('@bizbot/database');
    await tenantContext.run({ tenantId: dedup.tenantId, actor: { type: 'SYSTEM' } }, () =>
      this.prisma.client.$transaction(async (tx) => {
        await tx.processedWebhook.create({
          data: {
            source: dedup.source, key: dedup.key, tenantId: dedup.tenantId,
            response: dedup.response as Prisma.InputJsonValue,
          },
        });
        if (paymentId && intent.kind !== 'noop') {
          await this.applyIntentInTransaction(tx, paymentId, intent);
        }
      }),
    );
  }

  /**
   * Applies a normalized intent through the state machine, in one transaction.
   *
   * Reaching a state the payment is already in returns success without side effects —
   * that no-op is what makes a replay harmless, and it is why loyalty cannot be credited
   * twice for one payment.
   */
  async applyIntent(paymentId: string, intent: NormalizedIntent, tenantIdOverride?: string) {
    const tenantId = tenantIdOverride;

    const run = async () => {
      await this.prisma.client.$transaction((tx) => this.applyIntentInTransaction(tx, paymentId, intent));
    };

    // Webhooks arrive with no tenant in context, so one is established from the payment's
    // own tenant before touching the guarded client.
    if (tenantId) {
      const { tenantContext } = await import('@bizbot/database');
      return tenantContext.run({ tenantId, actor: { type: 'SYSTEM' } }, run);
    }
    return run();
  }

  private async applyIntentInTransaction(
    tx: GuardedTransactionClient,
    paymentId: string,
    intent: NormalizedIntent,
  ): Promise<void> {
    {
      {
        const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });

        const nextState = this.stateFor(intent);
        if (nextState === null) return;

        if (payment.state === nextState) {
          // Already there. Not an error — this is the replay path.
          return;
        }
        if (!ALLOWED_TRANSITIONS[payment.state].includes(nextState)) {
          logger.warn(
            { paymentId, from: payment.state, to: nextState },
            'Ignoring payment transition that is not allowed',
          );
          return;
        }

        // The provider's amount must match what we asked for. An underpayment silently
        // marked paid is a direct financial loss, so a mismatch fails loudly.
        if (intent.kind === 'mark_paid' && intent.amount !== payment.amount) {
          await tx.payment.update({
            where: { id: paymentId },
            data: { state: 'FAILED', failureReason: `Amount mismatch: expected ${payment.amount}, got ${intent.amount}` },
          });
          await this.audit.record({
            tenantId: payment.tenantId, action: 'payment.amount_mismatch',
            entityType: 'PAYMENT', entityId: paymentId,
            after: { expected: payment.amount, received: intent.amount },
          });
          throw new DomainError(ErrorCode.PAYMENT_AMOUNT_MISMATCH, undefined, {
            expected: payment.amount, received: intent.amount,
          });
        }

        await tx.payment.update({
          where: { id: paymentId },
          data: {
            state: nextState,
            externalId: 'externalId' in intent ? intent.externalId ?? payment.externalId : payment.externalId,
            paidAt: intent.kind === 'mark_paid' ? intent.paidAt : payment.paidAt,
            failureReason: intent.kind === 'mark_failed' ? intent.reason : undefined,
            refundedAmount: intent.kind === 'mark_refunded' ? intent.amount : payment.refundedAmount,
          },
        });

        await tx.paymentTransaction.create({
          data: {
            tenantId: payment.tenantId, paymentId,
            kind: intent.kind,
            amount: 'amount' in intent ? intent.amount : null,
            rawPayload: intent as unknown as Prisma.InputJsonValue,
          },
        });

        if (intent.kind === 'mark_paid') {
          if (payment.orderId) {
            await tx.order.update({
              where: { id: payment.orderId },
              data: { paymentStatus: 'PAID', status: 'ACCEPTED', acceptedAt: new Date() },
            });
          }
          if (payment.bookingId) {
            await tx.booking.update({
              where: { id: payment.bookingId },
              data: { paymentStatus: 'PAID', status: 'CONFIRMED', confirmedAt: new Date() },
            });
          }
          // Only emitted on a *real* transition, which is what stops a replay from
          // double-crediting loyalty or notifying the customer twice.
          await this.events.emit(tx, DomainEventType.PAYMENT_SUCCEEDED, { type: 'PAYMENT', id: paymentId }, {
            paymentId, orderId: payment.orderId ?? undefined, bookingId: payment.bookingId ?? undefined,
            customerId: payment.customerId ?? undefined, amount: payment.amount, provider: payment.provider,
          });
        } else if (intent.kind === 'mark_failed' || intent.kind === 'mark_cancelled') {
          if (payment.orderId) {
            await tx.order.update({ where: { id: payment.orderId }, data: { paymentStatus: 'FAILED' } });
          }
          await this.events.emit(tx, DomainEventType.PAYMENT_FAILED, { type: 'PAYMENT', id: paymentId }, {
            paymentId, orderId: payment.orderId ?? undefined, reason: intent.reason,
          });
        } else if (intent.kind === 'mark_refunded') {
          if (payment.orderId) {
            await tx.order.update({
              where: { id: payment.orderId },
              data: { paymentStatus: intent.amount >= payment.amount ? 'REFUNDED' : 'PARTIALLY_REFUNDED' },
            });
          }
          await this.events.emit(tx, DomainEventType.PAYMENT_REFUNDED, { type: 'PAYMENT', id: paymentId }, {
            paymentId, orderId: payment.orderId ?? undefined, amount: intent.amount,
          });
        }
      }
    }
  }

  async listForOrder(orderId: string) {
    return this.prisma.client.payment.findMany({
      where: { orderId }, orderBy: { createdAt: 'desc' },
      include: { transactions: { orderBy: { createdAt: 'desc' }, take: 10 } },
    });
  }

  /** Staff marking a cash order as paid at the counter. */
  async markCashPaid(actorUserId: string, orderId: string) {
    const order = await this.prisma.client.order.findFirstOrThrow({ where: { id: orderId } });
    if (order.paymentStatus === 'PAID') {
      throw new DomainError(ErrorCode.PAYMENT_ALREADY_FINALIZED);
    }

    const payment = await this.prisma.client.payment.create({
      data: {
        orderId, customerId: order.customerId, provider: 'cash', method: 'CASH',
        state: 'PENDING', amount: order.total, currency: order.currency,
      } as never,
    });

    await this.applyIntent(payment.id, {
      kind: 'mark_paid', externalId: `cash_${payment.id}`, amount: order.total, paidAt: new Date(),
    });

    await this.audit.record({
      tenantId: order.tenantId, actorUserId, action: 'payment.cash_received',
      entityType: 'ORDER', entityId: orderId, after: { amount: order.total },
    });
    return this.prisma.client.payment.findFirstOrThrow({ where: { id: payment.id } });
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private stateFor(intent: NormalizedIntent): PaymentState | null {
    switch (intent.kind) {
      case 'mark_paid': return 'PAID';
      case 'mark_failed': return 'FAILED';
      case 'mark_cancelled': return 'CANCELLED';
      case 'mark_refunded': return 'REFUNDED';
      default: return null;
    }
  }

  private async resolveProvider(
    providerKey: PaymentProviderKey,
    options: { returnUrl?: string; language?: 'uz' | 'ru' | 'en' },
  ) {
    const provider = getProvider(providerKey);

    // Cash needs no integration row; everything else does, and its absence is a
    // configuration error the owner can fix.
    if (providerKey === 'cash') {
      return {
        provider,
        integrationId: null,
        ctx: { tenantId: '', credentials: {}, config: {}, returnUrl: options.returnUrl, language: options.language ?? 'uz' },
      };
    }

    const integration = await this.prisma.client.integration.findFirst({
      where: { type: 'PAYMENT', provider: providerKey, isEnabled: true },
    });
    if (!integration) {
      throw new DomainError(ErrorCode.PAYMENT_PROVIDER_UNAVAILABLE, undefined, { provider: providerKey });
    }

    return {
      provider,
      integrationId: integration.id,
      ctx: {
        tenantId: integration.tenantId,
        credentials: this.openCredentials(integration),
        config: (integration.config ?? {}) as Record<string, unknown>,
        returnUrl: options.returnUrl,
        language: options.language ?? 'uz',
      } satisfies ProviderContext,
    };
  }

  private openCredentials(integration: {
    secretCipher: string | null; secretIv: string | null; secretTag: string | null; keyVersion: number;
  }): Record<string, string> {
    if (!integration.secretCipher || !integration.secretIv || !integration.secretTag) return {};
    return this.vault.openJson({
      cipher: integration.secretCipher, iv: integration.secretIv,
      tag: integration.secretTag, keyVersion: integration.keyVersion,
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code: string }).code === 'P2002'
  );
}
