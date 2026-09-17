import { timingSafeEqual } from 'node:crypto';
import type {
  CreatePaymentResult,
  PaymentProvider,
  PaymentStatusResult,
  ProviderContext,
  PaymentSubject,
  RefundResult,
  WebhookOutcome,
  WebhookRequest,
} from '../provider';
import { PaymentProviderError } from '../provider';

/**
 * Payme (Uzbekistan).
 *
 * Payme speaks JSON-RPC over a single endpoint, authenticated with HTTP Basic where the
 * password is the merchant key. Its error codes are part of the contract — returning the
 * wrong one makes Payme retry forever or cancel a good transaction — so they are encoded
 * here rather than improvised at the call site.
 *
 * Payme sends amounts in tiyin (1/100 so'm) even though tiyin is obsolete in cash. We
 * store UZS with exponent 0, so every amount crossing this boundary is converted, and
 * getting that wrong by 100x is the single most expensive bug available in this adapter.
 */

export const PAYME_ERROR = {
  TRANSPORT: -32300,
  PARSE: -32700,
  INVALID_RPC: -32600,
  METHOD_NOT_FOUND: -32601,
  INSUFFICIENT_PRIVILEGE: -32504,
  INVALID_AMOUNT: -31001,
  TRANSACTION_NOT_FOUND: -31003,
  CANNOT_PERFORM: -31008,
  CANNOT_CANCEL: -31007,
  ORDER_NOT_FOUND: -31050,
} as const;

const TIYIN_PER_SOM = 100;

interface PaymeRpc {
  method: string;
  params: Record<string, unknown>;
  id: number | string;
}

export class PaymeProvider implements PaymentProvider {
  readonly key = 'payme' as const;
  readonly capabilities = { refund: true, hold: true, webhook: true, redirect: true };
  readonly requiredCredentials = ['merchantId', 'key'] as const;

  async createPayment(ctx: ProviderContext, subject: PaymentSubject): Promise<CreatePaymentResult> {
    const merchantId = this.credential(ctx, 'merchantId');

    // Payme's checkout takes a base64 parameter string. Amount must be in tiyin.
    const params = [
      `m=${merchantId}`,
      `ac.payment_id=${subject.paymentId}`,
      `a=${subject.amount * TIYIN_PER_SOM}`,
      `l=${ctx.language === 'ru' ? 'ru' : 'uz'}`,
      ...(ctx.returnUrl ? [`c=${ctx.returnUrl}`] : []),
    ].join(';');

    return {
      checkoutUrl: `https://checkout.paycom.uz/${Buffer.from(params).toString('base64')}`,
      settledImmediately: false,
    };
  }

  async getPaymentStatus(): Promise<PaymentStatusResult> {
    return { state: 'PENDING' };
  }

  async cancelPayment(): Promise<void> {}

  async refundPayment(
    _ctx: ProviderContext,
    _s: PaymentSubject,
    amount: number,
  ): Promise<RefundResult> {
    // Payme cancels a performed transaction rather than issuing a separate refund; the
    // cancel arrives as a CancelTransaction webhook, which is where the ledger updates.
    return { refundedAmount: amount };
  }

  async verifyWebhook(ctx: ProviderContext, request: WebhookRequest): Promise<void> {
    const header = request.headers.authorization;
    if (!header?.startsWith('Basic ')) {
      throw new PaymentProviderError('payme', 'NO_AUTH', 'Missing Basic authorization');
    }

    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    const password = separator >= 0 ? decoded.slice(separator + 1) : '';
    const expected = this.credential(ctx, 'key');

    const a = Buffer.from(password, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new PaymentProviderError('payme', 'BAD_AUTH', 'Payme merchant key mismatch');
    }
  }

  async handleWebhook(_ctx: ProviderContext, request: WebhookRequest): Promise<WebhookOutcome> {
    const rpc = request.parsedBody as PaymeRpc;
    const id = rpc?.id ?? 0;
    const params = rpc?.params ?? {};
    const paymentId = this.paymentIdFrom(params);

    switch (rpc?.method) {
      case 'CheckPerformTransaction':
        // Payme asks whether the order can be paid. The service layer answers by looking
        // the payment up; the adapter only shapes the reply.
        return {
          idempotencyKey: `payme:check:${paymentId}:${params.amount}`,
          paymentId,
          intent: { kind: 'noop', reason: 'CheckPerformTransaction' },
          response: { result: { allow: true }, id },
        };

      case 'CreateTransaction':
        return {
          idempotencyKey: `payme:create:${String(params.id)}`,
          paymentId,
          intent: { kind: 'noop', reason: 'Payme transaction created' },
          response: {
            result: {
              create_time: Number(params.time) || Date.now(),
              transaction: String(params.id),
              state: 1,
            },
            id,
          },
        };

      case 'PerformTransaction':
        return {
          idempotencyKey: `payme:perform:${String(params.id)}`,
          paymentId,
          intent: {
            kind: 'mark_paid',
            externalId: String(params.id),
            // Back to our storage unit. Getting this conversion wrong by 100x is the
            // most expensive mistake available here.
            amount: Math.round(Number(params.amount ?? 0) / TIYIN_PER_SOM),
            paidAt: new Date(),
          },
          response: {
            result: { perform_time: Date.now(), transaction: String(params.id), state: 2 },
            id,
          },
        };

      case 'CancelTransaction':
        return {
          idempotencyKey: `payme:cancel:${String(params.id)}:${String(params.reason)}`,
          paymentId,
          intent: {
            kind: 'mark_cancelled',
            externalId: String(params.id),
            reason: `Payme reason ${String(params.reason)}`,
          },
          response: {
            result: { cancel_time: Date.now(), transaction: String(params.id), state: -1 },
            id,
          },
        };

      case 'CheckTransaction':
        return {
          idempotencyKey: `payme:status:${String(params.id)}:${Date.now()}`,
          paymentId,
          intent: { kind: 'noop', reason: 'CheckTransaction' },
          response: { result: { transaction: String(params.id) }, id },
        };

      default:
        return {
          idempotencyKey: `payme:unknown:${Date.now()}`,
          intent: { kind: 'noop', reason: `Unknown Payme method ${rpc?.method}` },
          response: {
            error: { code: PAYME_ERROR.METHOD_NOT_FOUND, message: 'Method not found' },
            id,
          },
        };
    }
  }

  /** Our payment id travels in `account`, under the field configured in the cabinet. */
  private paymentIdFrom(params: Record<string, unknown>): string | undefined {
    const account = params.account as Record<string, string> | undefined;
    return account?.payment_id ?? account?.order_id ?? undefined;
  }

  private credential(ctx: ProviderContext, key: string): string {
    const value = ctx.credentials[key];
    if (!value) {
      throw new PaymentProviderError(
        'payme',
        'MISSING_CREDENTIAL',
        `Payme integration is missing "${key}"`,
      );
    }
    return value;
  }
}

export { TIYIN_PER_SOM };
