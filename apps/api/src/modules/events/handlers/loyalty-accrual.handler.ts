import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma.service';
import { LoyaltyService } from '../../loyalty/loyalty.service';
import { EventDispatcher, type EventHandler } from '../event-dispatcher.service';
import { DomainEventType, type EmittedEvent } from '../event-types';

/**
 * Credits cashback when an order completes.
 *
 * On completion rather than at checkout, because an unpaid or cancelled order must never
 * earn bonuses. Safe to run twice: the ledger's (orderId, type) unique constraint rejects
 * a duplicate accrual, which is what makes at-least-once delivery harmless here (I4/I5).
 */
@Injectable()
export class LoyaltyAccrualHandler implements EventHandler, OnModuleInit {
  readonly name = 'loyalty-accrual';
  readonly subscribesTo = [DomainEventType.ORDER_COMPLETED];

  constructor(
    private readonly prisma: PrismaService,
    private readonly loyalty: LoyaltyService,
    private readonly dispatcher: EventDispatcher,
  ) {}

  onModuleInit() {
    this.dispatcher.register(this);
  }

  async handle(event: EmittedEvent): Promise<void> {
    const { orderId, customerId } = event.payload as { orderId: string; customerId: string };

    const order = await this.prisma.client.order.findFirst({ where: { id: orderId } });
    if (!order || order.loyaltyEarned <= 0) return;

    // The loyalty module may have been switched off between checkout and completion.
    const module = await this.prisma.client.tenantModule.findFirst({
      where: { module: 'LOYALTY', enabled: true },
    });
    if (!module) return;

    await this.prisma.client.$transaction((tx) =>
      this.loyalty.accrueForOrder(tx, {
        tenantId: event.tenantId,
        customerId,
        orderId,
        amount: order.loyaltyEarned,
      }),
    );
  }
}
