import { Injectable } from '@nestjs/common';
import { tenantContext, type GuardedTransactionClient } from '@bizbot/database';
import { DomainError, ErrorCode, normalizePageParams, paginate, toSkipTake } from '@bizbot/shared';
import { PrismaService } from '../../infra/prisma.service';
import { EventBus } from '../events/event-bus.service';
import { DomainEventType } from '../events/event-types';
import { AuditService } from '../audit/audit.service';

/**
 * Loyalty.
 *
 * Invariant I5: the balance is a cached projection of an append-only ledger, and it is
 * never written without a ledger row in the same transaction. Every mutation in this
 * file goes through `post`, so there is exactly one way a balance can change — and a
 * reconciliation query can always prove the two agree.
 */
@Injectable()
export class LoyaltyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
  ) {}

  async account(customerId: string) {
    const account = await this.prisma.client.loyaltyAccount.findFirst({ where: { customerId } });
    if (account) return account;
    // Accounts are created lazily: a customer who has never earned anything still needs
    // somewhere to receive their first bonus.
    return this.prisma.client.loyaltyAccount.create({ data: { customerId } as never });
  }

  async transactions(customerId: string, query: { page?: number; pageSize?: number }) {
    const account = await this.account(customerId);
    const page = normalizePageParams(query);
    const [items, total] = await Promise.all([
      this.prisma.client.loyaltyTransaction.findMany({
        where: { accountId: account.id },
        orderBy: { createdAt: 'desc' },
        ...toSkipTake(page),
      }),
      this.prisma.client.loyaltyTransaction.count({ where: { accountId: account.id } }),
    ]);
    return { account, ...paginate(items, total, page) };
  }

  /**
   * Manual adjustment by staff — a goodwill credit, or correcting a mistake.
   * Always requires a reason, because an unexplained balance change is the thing an
   * owner will ask about six months later.
   */
  async adjust(actorUserId: string, customerId: string, amount: number, reason: string) {
    if (amount === 0) throw new DomainError(ErrorCode.VALIDATION_FAILED, 'Amount cannot be zero');

    const result = await this.prisma.client.$transaction(async (tx) => {
      const account = await this.loadAccountForUpdate(tx, customerId);
      const balanceAfter = account.balance + amount;
      if (balanceAfter < 0) {
        throw new DomainError(ErrorCode.INSUFFICIENT_LOYALTY_BALANCE, undefined, {
          available: account.balance,
          requested: Math.abs(amount),
        });
      }
      return this.post(tx, {
        account,
        type: 'ADJUSTMENT',
        amount,
        balanceAfter,
        reason,
        actorUserId,
      });
    });

    await this.audit.record({
      actorUserId,
      action: 'loyalty.adjusted',
      entityType: 'CUSTOMER',
      entityId: customerId,
      after: { amount, reason, balanceAfter: result.balanceAfter },
    });
    return result;
  }

  /**
   * Cashback accrual. Called by the order.completed handler, not from checkout — an
   * unpaid or cancelled order must never earn bonuses.
   *
   * The (orderId, type) unique constraint makes this safe to call twice: a duplicate
   * accrual is rejected by the database, which is what keeps a webhook replay from
   * double-crediting a customer (invariant I4).
   */
  async accrueForOrder(
    tx: GuardedTransactionClient,
    input: { tenantId: string; customerId: string; orderId: string; amount: number },
  ) {
    if (input.amount <= 0) return null;

    const account = await this.loadAccountForUpdate(tx, input.customerId);
    const balanceAfter = account.balance + input.amount;

    try {
      return await this.post(tx, {
        account,
        type: 'EARN',
        amount: input.amount,
        balanceAfter,
        orderId: input.orderId,
        reason: 'Buyurtma uchun keshbek',
      });
    } catch (error) {
      // Unique violation on (orderId, type) means this order already earned its cashback.
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  async refundForOrder(
    tx: GuardedTransactionClient,
    input: { customerId: string; orderId: string; amount: number },
  ) {
    if (input.amount <= 0) return null;
    const account = await this.loadAccountForUpdate(tx, input.customerId);
    try {
      return await this.post(tx, {
        account,
        type: 'REFUND',
        amount: input.amount,
        balanceAfter: account.balance + input.amount,
        orderId: input.orderId,
        reason: 'Buyurtma qaytarildi',
      });
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  /**
   * The only place a loyalty balance is ever written.
   *
   * Ledger row, account projection and the customer's denormalized copy move together,
   * inside the caller's transaction. Splitting these would be how a balance and its
   * history drift apart.
   */
  private async post(
    tx: GuardedTransactionClient,
    input: {
      account: { id: string; tenantId: string; customerId: string; balance: number };
      type: 'EARN' | 'SPEND' | 'ADJUSTMENT' | 'EXPIRE' | 'REFUND';
      amount: number;
      balanceAfter: number;
      reason?: string;
      orderId?: string;
      actorUserId?: string;
    },
  ) {
    const transaction = await tx.loyaltyTransaction.create({
      data: {
        tenantId: input.account.tenantId,
        accountId: input.account.id,
        orderId: input.orderId,
        type: input.type,
        amount: input.amount,
        balanceAfter: input.balanceAfter,
        reason: input.reason,
        actorUserId: input.actorUserId,
      },
    });

    await tx.loyaltyAccount.update({
      where: { id: input.account.id },
      data: {
        balance: input.balanceAfter,
        ...(input.amount > 0
          ? { lifetimeEarned: { increment: BigInt(input.amount) } }
          : { lifetimeSpent: { increment: BigInt(-input.amount) } }),
      },
    });

    await tx.customer.update({
      where: { id: input.account.customerId },
      data: { loyaltyBalance: input.balanceAfter },
    });

    if (input.type === 'EARN') {
      await this.events.emit(
        tx,
        DomainEventType.LOYALTY_EARNED,
        { type: 'CUSTOMER', id: input.account.customerId },
        {
          customerId: input.account.customerId,
          amount: input.amount,
          balance: input.balanceAfter,
          orderId: input.orderId,
        },
      );
    }

    return transaction;
  }

  /**
   * Locks the account row for the duration of the transaction.
   *
   * Two concurrent operations on one customer — a checkout spending bonuses while a
   * completed order credits them — would otherwise read the same balance and write
   * conflicting projections.
   *
   * The tenant predicate is not optional. Raw SQL bypasses the Prisma tenant guard
   * entirely, and this method takes a customer id straight from a route parameter: without
   * it, an admin of one business could lock and adjust another business's loyalty account
   * (risk R13). Every raw query in this codebase carries its own tenant filter for this
   * reason.
   */
  private async loadAccountForUpdate(tx: GuardedTransactionClient, customerId: string) {
    const tenantId = tenantContext.tenantId();
    if (!tenantId) {
      throw new DomainError(
        ErrorCode.MISSING_TENANT_CONTEXT,
        'Loyalty requires a tenant in context',
      );
    }

    const rows = await tx.$queryRaw<
      { id: string; tenantId: string; customerId: string; balance: number }[]
    >`
      SELECT id, "tenantId", "customerId", balance
      FROM "LoyaltyAccount"
      WHERE "customerId" = ${customerId}
        AND "tenantId" = ${tenantId}
      FOR UPDATE
    `;
    const account = rows[0];
    if (!account) throw new DomainError(ErrorCode.NOT_FOUND, 'Loyalty account not found');
    return account;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: string }).code === 'P2002'
  );
}
