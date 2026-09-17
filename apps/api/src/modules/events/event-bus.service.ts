import { Injectable } from '@nestjs/common';
import type { GuardedTransactionClient, Prisma } from '@bizbot/database';
import { tenantContext } from '@bizbot/database';
import { DomainError, ErrorCode } from '@bizbot/shared';
import type { DomainEventPayloads, DomainEventTypeValue } from './event-types';

/** The guarded transaction client. Events are always written through one. */
export type TxClient = GuardedTransactionClient;

/**
 * Transactional outbox.
 *
 * `emit` takes the transaction client rather than opening its own connection, and that
 * is the whole point: the business change and its event either both commit or neither
 * does. Publishing to a broker inside a transaction is a lie — the transaction can roll
 * back after the message has already left (docs/adr/0005-transactional-outbox.md).
 *
 * A separate dispatcher drains the table. Nothing here talks to a queue.
 */
@Injectable()
export class EventBus {
  async emit<T extends DomainEventTypeValue>(
    tx: TxClient,
    type: T,
    aggregate: { type: string; id: string },
    payload: T extends keyof DomainEventPayloads ? DomainEventPayloads[T] : Record<string, unknown>,
    options?: { tenantId?: string; actorUserId?: string; version?: number; availableAt?: Date },
  ): Promise<void> {
    const tenantId = options?.tenantId ?? tenantContext.tenantId();
    if (!tenantId) {
      // An event without a tenant could be delivered to the wrong business, so this is
      // refused rather than defaulted.
      throw new DomainError(
        ErrorCode.MISSING_TENANT_CONTEXT,
        `Cannot emit ${type} without a tenant in context`,
      );
    }

    await tx.domainEvent.create({
      data: {
        tenantId,
        type,
        version: options?.version ?? 1,
        aggregateType: aggregate.type,
        aggregateId: aggregate.id,
        payload: payload as Prisma.InputJsonValue,
        actorUserId: options?.actorUserId ?? tenantContext.actor()?.userId ?? null,
        availableAt: options?.availableAt ?? new Date(),
      },
    });
  }
}
