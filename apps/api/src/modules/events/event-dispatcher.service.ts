import { Injectable, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { tenantContext } from '@bizbot/database';
import { PrismaService } from '../../infra/prisma.service';
import { logger } from '../../common/logger';
import type { EmittedEvent } from './event-types';

export interface EventHandler {
  /** Stable name — it is the idempotency key together with the event id. */
  readonly name: string;
  /** Event types this handler wants. '*' subscribes to everything. */
  readonly subscribesTo: readonly string[];
  handle(event: EmittedEvent): Promise<void>;
}

/**
 * Drains the outbox.
 *
 * Delivery is at-least-once, which is the only honest guarantee: a handler can succeed
 * and the process can die before the run is recorded. Every handler is therefore keyed
 * on (eventId, handlerName) in EventHandlerRun and must be safe to re-run.
 *
 * Events for one aggregate are processed in order; across aggregates there is no
 * ordering guarantee and no consumer may assume one.
 */
@Injectable()
export class EventDispatcher implements OnModuleInit {
  private readonly handlers: EventHandler[] = [];
  private draining = false;

  constructor(private readonly prisma: PrismaService) {}

  register(handler: EventHandler): void {
    this.handlers.push(handler);
    logger.debug({ handler: handler.name, events: handler.subscribesTo }, 'Event handler registered');
  }

  onModuleInit() {
    logger.info({ handlers: this.handlers.length }, 'Event dispatcher ready');
  }

  @Interval(2000)
  async drainTick(): Promise<void> {
    // A slow batch must not pile up ticks behind it.
    if (this.draining) return;
    this.draining = true;
    try {
      await this.drain();
    } catch (error) {
      logger.error({ err: error }, 'Event drain failed');
    } finally {
      this.draining = false;
    }
  }

  async drain(batchSize = 50): Promise<number> {
    const claimed = await this.prisma.system('event-drain', async () => {
      // Claim with a conditional update so two workers cannot take the same rows.
      const candidates = await this.prisma.raw.domainEvent.findMany({
        where: { status: { in: ['PENDING', 'FAILED'] }, availableAt: { lte: new Date() } },
        orderBy: { occurredAt: 'asc' },
        take: batchSize,
        select: { id: true },
      });
      if (candidates.length === 0) return [];

      const ids = candidates.map((c) => c.id);
      const { count } = await this.prisma.raw.domainEvent.updateMany({
        where: { id: { in: ids }, status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'PROCESSING' },
      });
      if (count === 0) return [];

      return this.prisma.raw.domainEvent.findMany({
        where: { id: { in: ids }, status: 'PROCESSING' },
        orderBy: { occurredAt: 'asc' },
      });
    });

    for (const row of claimed) {
      await this.process(row);
    }
    return claimed.length;
  }

  private async process(row: {
    id: string; tenantId: string; type: string; version: number;
    aggregateType: string; aggregateId: string; payload: unknown;
    occurredAt: Date; attempts: number;
  }): Promise<void> {
    const event: EmittedEvent = {
      id: row.id,
      tenantId: row.tenantId,
      type: row.type as EmittedEvent['type'],
      version: row.version,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      payload: row.payload as EmittedEvent['payload'],
      occurredAt: row.occurredAt,
    };

    const interested = this.handlers.filter(
      (h) => h.subscribesTo.includes('*') || h.subscribesTo.includes(row.type),
    );

    const failures: string[] = [];

    for (const handler of interested) {
      // Skip a handler that already succeeded for this event — the idempotency guard
      // that makes at-least-once delivery safe.
      const previous = await this.prisma.system('event-handler-run-check', () =>
        this.prisma.raw.eventHandlerRun.findUnique({
          where: { eventId_handler: { eventId: row.id, handler: handler.name } },
          select: { succeeded: true },
        }),
      );
      if (previous?.succeeded) continue;

      try {
        // Handlers run inside the event's tenant, so they use the guarded client
        // normally and cannot accidentally touch another business.
        await tenantContext.run({ tenantId: row.tenantId, actor: { type: 'SYSTEM' } }, () =>
          handler.handle(event),
        );
        await this.recordRun(row.id, handler.name, true);
      } catch (error) {
        failures.push(handler.name);
        logger.error(
          { err: error, eventId: row.id, type: row.type, handler: handler.name },
          'Event handler failed',
        );
        await this.recordRun(row.id, handler.name, false, String(error));
      }
    }

    const attempts = row.attempts + 1;
    const exhausted = attempts >= 5;

    await this.prisma.system('event-finalize', () =>
      this.prisma.raw.domainEvent.update({
        where: { id: row.id },
        data:
          failures.length === 0
            ? { status: 'PROCESSED', processedAt: new Date(), attempts, lastError: null }
            : {
                status: exhausted ? 'FAILED' : 'PENDING',
                attempts,
                lastError: `Handlers failed: ${failures.join(', ')}`,
                // Exponential backoff, capped — a persistently failing handler must not
                // spin the dispatcher.
                availableAt: new Date(Date.now() + Math.min(2 ** attempts, 300) * 1000),
              },
      }),
    );
  }

  private async recordRun(eventId: string, handler: string, succeeded: boolean, error?: string) {
    await this.prisma.system('event-handler-run', () =>
      this.prisma.raw.eventHandlerRun.upsert({
        where: { eventId_handler: { eventId, handler } },
        create: { eventId, handler, succeeded, error },
        update: { succeeded, error },
      }),
    );
  }
}
