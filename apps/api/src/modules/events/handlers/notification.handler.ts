import { Injectable, OnModuleInit } from '@nestjs/common';
import { formatMoney, type Language } from '@bizbot/shared';
import { PrismaService } from '../../../infra/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { QueueService, QUEUES } from '../../../infra/queue.service';
import { EventDispatcher, type EventHandler } from '../event-dispatcher.service';
import { DomainEventType, type EmittedEvent } from '../event-types';

/**
 * Turns business facts into customer messages.
 *
 * Every notification the platform sends flows through here, which is what keeps the
 * ordering, wording and channel logic in one place instead of scattered through the
 * services that happen to change a status.
 */
@Injectable()
export class NotificationHandler implements EventHandler, OnModuleInit {
  readonly name = 'notification-dispatcher';
  readonly subscribesTo = [
    DomainEventType.ORDER_CREATED,
    DomainEventType.ORDER_STATUS_CHANGED,
    DomainEventType.BOOKING_CREATED,
    DomainEventType.BOOKING_CANCELLED,
    DomainEventType.PAYMENT_SUCCEEDED,
    DomainEventType.LOYALTY_EARNED,
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly queue: QueueService,
    private readonly dispatcher: EventDispatcher,
  ) {}

  onModuleInit() {
    this.dispatcher.register(this);
  }

  async handle(event: EmittedEvent): Promise<void> {
    const p = event.payload as Record<string, unknown>;
    const customerId = p.customerId as string | undefined;
    if (!customerId) return;

    const tenant = await this.prisma.client.tenant.findFirstOrThrow();
    const customer = await this.prisma.client.customer.findFirst({
      where: { id: customerId },
      select: { language: true },
    });
    const lang = (customer?.language as Language) ?? 'uz';
    const money = (n: unknown) => formatMoney(Number(n ?? 0), tenant.currency as never, lang);

    switch (event.type) {
      case DomainEventType.ORDER_CREATED:
        await this.notifications.send({
          tenantId: event.tenantId,
          customerId,
          templateKey: 'ORDER_CREATED',
          variables: { orderNumber: String(p.orderNumber), total: money(p.total) },
        });
        break;

      case DomainEventType.ORDER_STATUS_CHANGED: {
        // Only the transitions a customer cares about. Notifying on every internal step
        // trains people to ignore the bot.
        const key = {
          ACCEPTED: 'ORDER_ACCEPTED',
          PREPARING: 'ORDER_ACCEPTED',
          READY: 'ORDER_READY',
          DELIVERING: 'ORDER_DELIVERING',
          COMPLETED: 'ORDER_COMPLETED',
          CANCELLED: 'ORDER_CANCELLED',
        }[String(p.to)];
        if (!key) return;
        await this.notifications.send({
          tenantId: event.tenantId,
          customerId,
          templateKey: key,
          variables: { orderNumber: String(p.orderNumber), status: String(p.to) },
        });
        break;
      }

      case DomainEventType.BOOKING_CREATED: {
        const booking = await this.prisma.client.booking.findFirst({
          where: { id: p.bookingId as string },
          include: { resource: { select: { name: true } }, service: { select: { name: true } } },
        });
        if (!booking) return;

        const local = this.localParts(booking.startsAt, tenant.timezone);
        await this.notifications.send({
          tenantId: event.tenantId,
          customerId,
          templateKey: 'BOOKING_CREATED',
          bookingId: booking.id,
          variables: {
            service:
              (booking.serviceNameSnapshot as Record<string, string>)?.[lang] ??
              (booking.serviceNameSnapshot as Record<string, string>)?.uz ??
              '',
            date: local.date,
            time: local.time,
            employee: booking.resource.name,
          },
        });

        await this.scheduleReminders(event.tenantId, booking.id, booking.startsAt);
        break;
      }

      case DomainEventType.BOOKING_CANCELLED: {
        const local = this.localParts(new Date(String(p.startsAt)), tenant.timezone);
        await this.notifications.send({
          tenantId: event.tenantId,
          customerId,
          templateKey: 'BOOKING_CANCELLED',
          bookingId: p.bookingId as string,
          variables: { date: local.date, time: local.time },
        });
        // A cancelled appointment must not still send a reminder.
        await this.cancelReminders(p.bookingId as string);
        break;
      }

      case DomainEventType.PAYMENT_SUCCEEDED:
        await this.notifications.send({
          tenantId: event.tenantId,
          customerId,
          templateKey: 'PAYMENT_SUCCESS',
          variables: { amount: money(p.amount) },
        });
        break;

      case DomainEventType.LOYALTY_EARNED:
        await this.notifications.send({
          tenantId: event.tenantId,
          customerId,
          templateKey: 'LOYALTY_EARNED',
          variables: { amount: money(p.amount), balance: money(p.balance) },
        });
        break;
    }
  }

  /**
   * Schedules reminders at the tenant's configured offsets.
   *
   * The job id is derived from the booking and offset, so rescheduling is idempotent and
   * a duplicate enqueue is a no-op. The Notification row is additionally unique on
   * (bookingId, templateKey, scheduledFor), so even a job that somehow runs twice cannot
   * produce two messages.
   */
  private async scheduleReminders(tenantId: string, bookingId: string, startsAt: Date) {
    const settings = await this.prisma.client.tenantSettings.findFirst();
    const offsets = (settings?.bookingSettings as { reminderOffsetsMinutes?: number[] })
      ?.reminderOffsetsMinutes ?? [1440, 120];

    for (const minutes of offsets) {
      const runAt = new Date(startsAt.getTime() - minutes * 60_000);
      // A booking made an hour before the appointment must not fire a 24-hour reminder.
      if (runAt.getTime() <= Date.now()) continue;

      await this.queue.schedule(
        QUEUES.NOTIFICATIONS,
        'booking-reminder',
        { tenantId, bookingId, offsetMinutes: minutes },
        runAt,
        `reminder:${bookingId}:${minutes}`,
      );
    }
  }

  private async cancelReminders(bookingId: string) {
    for (const minutes of [1440, 120, 60, 30]) {
      await this.queue.cancel(QUEUES.NOTIFICATIONS, `reminder:${bookingId}:${minutes}`);
    }
  }

  private localParts(instant: Date, timezone: string) {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(instant).map((p) => [p.type, p.value]),
    );
    return {
      date: `${parts.day}.${parts.month}.${parts.year}`,
      time: `${parts.hour}:${parts.minute}`,
    };
  }
}
