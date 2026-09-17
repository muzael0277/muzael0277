import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma.service';
import { EventDispatcher, type EventHandler } from '../event-dispatcher.service';
import { DomainEventType } from '../event-types';
import type { EmittedEvent } from '../event-types';

/**
 * Projects domain events into the customer timeline.
 *
 * The timeline is assembled here rather than written by the UI, which is what keeps it
 * complete: an order created by the bot, the Mini App or a staff member all land the
 * same way, because they all emit the same event.
 */
@Injectable()
export class TimelineProjector implements EventHandler, OnModuleInit {
  readonly name = 'timeline-projector';
  readonly subscribesTo = [
    DomainEventType.CUSTOMER_CREATED,
    DomainEventType.ORDER_CREATED,
    DomainEventType.ORDER_STATUS_CHANGED,
    DomainEventType.ORDER_COMPLETED,
    DomainEventType.ORDER_CANCELLED,
    DomainEventType.BOOKING_CREATED,
    DomainEventType.BOOKING_CANCELLED,
    DomainEventType.BOOKING_COMPLETED,
    DomainEventType.PAYMENT_SUCCEEDED,
    DomainEventType.LOYALTY_EARNED,
    DomainEventType.LOYALTY_SPENT,
    DomainEventType.PROMO_USED,
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: EventDispatcher,
  ) {}

  onModuleInit() { this.dispatcher.register(this); }

  async handle(event: EmittedEvent): Promise<void> {
    const payload = event.payload as Record<string, unknown>;
    const customerId = payload.customerId as string | undefined;
    if (!customerId) return;

    const entry = this.describe(event.type, payload);
    if (!entry) return;

    await this.prisma.client.customerTimelineEntry.create({
      data: {
        customerId,
        type: event.type.toUpperCase().replace('.', '_'),
        title: entry.title as never,
        body: (entry.body ?? null) as never,
        amount: entry.amount ?? null,
        entityType: event.aggregateType,
        entityId: event.aggregateId,
        metadata: payload as never,
        occurredAt: event.occurredAt,
      } as never,
    });
  }

  private describe(type: string, p: Record<string, unknown>) {
    switch (type) {
      case DomainEventType.CUSTOMER_CREATED:
        return { title: { uz: 'Mijoz qo‘shildi', ru: 'Клиент добавлен' } };
      case DomainEventType.ORDER_CREATED:
        return {
          title: { uz: `Buyurtma ${p.orderNumber}`, ru: `Заказ ${p.orderNumber}` },
          amount: p.total as number,
        };
      case DomainEventType.ORDER_STATUS_CHANGED:
        return {
          title: { uz: `Buyurtma holati: ${p.to}`, ru: `Статус заказа: ${p.to}` },
          body: { uz: `${p.from} → ${p.to}`, ru: `${p.from} → ${p.to}` },
        };
      case DomainEventType.ORDER_COMPLETED:
        return {
          title: { uz: `Buyurtma yakunlandi ${p.orderNumber}`, ru: `Заказ завершён ${p.orderNumber}` },
          amount: p.total as number,
        };
      case DomainEventType.ORDER_CANCELLED:
        return {
          title: { uz: `Buyurtma bekor qilindi ${p.orderNumber}`, ru: `Заказ отменён ${p.orderNumber}` },
          body: p.reason ? { uz: String(p.reason), ru: String(p.reason) } : undefined,
        };
      case DomainEventType.BOOKING_CREATED:
        return { title: { uz: `Bron ${p.bookingNumber}`, ru: `Запись ${p.bookingNumber}` } };
      case DomainEventType.BOOKING_CANCELLED:
        return { title: { uz: 'Bron bekor qilindi', ru: 'Запись отменена' } };
      case DomainEventType.BOOKING_COMPLETED:
        return {
          title: { uz: 'Bron yakunlandi', ru: 'Запись завершена' },
          amount: p.price as number,
        };
      case DomainEventType.PAYMENT_SUCCEEDED:
        return {
          title: { uz: 'To‘lov qabul qilindi', ru: 'Оплата получена' },
          amount: p.amount as number,
        };
      case DomainEventType.LOYALTY_EARNED:
        return {
          title: { uz: 'Bonus qo‘shildi', ru: 'Начислены бонусы' },
          amount: p.amount as number,
        };
      case DomainEventType.LOYALTY_SPENT:
        return {
          title: { uz: 'Bonus ishlatildi', ru: 'Бонусы потрачены' },
          amount: -(p.amount as number),
        };
      case DomainEventType.PROMO_USED:
        return {
          title: { uz: `Promokod ishlatildi: ${p.code}`, ru: `Промокод применён: ${p.code}` },
          amount: -(p.discount as number),
        };
      default:
        return null;
    }
  }
}
