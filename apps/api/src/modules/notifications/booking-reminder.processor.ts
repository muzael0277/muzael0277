import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import { loadEnv } from '@bizbot/config';
import { tenantContext } from '@bizbot/database';
import { RedisService } from '../../infra/redis.service';
import { QUEUES } from '../../infra/queue.service';
import { PrismaService } from '../../infra/prisma.service';
import { NotificationsService } from './notifications.service';
import { logger } from '../../common/logger';

/**
 * Booking reminders.
 *
 * Every job re-reads the booking before sending, because a lot can change between
 * scheduling a reminder and firing it: the appointment may have been cancelled,
 * rescheduled or already completed. Sending a reminder for a cancelled appointment is
 * worse than sending none.
 */
@Injectable()
export class BookingReminderProcessor implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker;
  private readonly env = loadEnv();

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    // In the API process this only runs when explicitly enabled for local development;
    // in production the worker process owns it.
    if (!this.env.RUN_WORKER_IN_API && process.env.BIZBOT_ROLE !== 'worker') return;

    this.worker = new Worker(
      QUEUES.NOTIFICATIONS,
      async (job) => {
        if (job.name !== 'booking-reminder') return;
        const { tenantId, bookingId, offsetMinutes } = job.data as {
          tenantId: string;
          bookingId: string;
          offsetMinutes: number;
        };
        await tenantContext.run({ tenantId, actor: { type: 'SYSTEM' } }, () =>
          this.sendReminder(tenantId, bookingId, offsetMinutes),
        );
      },
      {
        connection: this.redis.client,
        prefix: this.env.QUEUE_PREFIX,
        concurrency: this.env.WORKER_CONCURRENCY,
      },
    );

    this.worker.on('failed', (job, error) => {
      logger.error({ err: error, jobId: job?.id }, 'Booking reminder job failed');
    });
    logger.info('Booking reminder processor started');
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  private async sendReminder(tenantId: string, bookingId: string, offsetMinutes: number) {
    const booking = await this.prisma.client.booking.findFirst({
      where: { id: bookingId },
      include: { resource: { select: { name: true } } },
    });

    // Cancelled, completed, or rescheduled past this reminder's window: nothing to send.
    if (!booking) return;
    if (
      booking.status === 'CANCELLED' ||
      booking.status === 'NO_SHOW' ||
      booking.status === 'COMPLETED'
    )
      return;
    if (booking.startsAt.getTime() < Date.now()) return;

    const tenant = await this.prisma.client.tenant.findFirstOrThrow();
    const scheduledFor = new Date(booking.startsAt.getTime() - offsetMinutes * 60_000);

    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: tenant.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(booking.startsAt).map((p) => [p.type, p.value]),
    );
    const serviceName = booking.serviceNameSnapshot as Record<string, string>;

    await this.notifications.send({
      tenantId,
      customerId: booking.customerId,
      templateKey: 'BOOKING_REMINDER',
      bookingId,
      // The unique (bookingId, templateKey, scheduledFor) constraint makes a duplicate
      // job harmless even if BullMQ delivers one twice.
      scheduledFor,
      variables: {
        date: `${parts.day}.${parts.month}.${parts.year}`,
        time: `${parts.hour}:${parts.minute}`,
        service: serviceName?.uz ?? '',
        employee: booking.resource.name,
      },
    });
  }
}
