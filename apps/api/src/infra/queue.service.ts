import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import { loadEnv } from '@bizbot/config';
import { RedisService } from './redis.service';
import { logger } from '../common/logger';

export const QUEUES = {
  EVENTS: 'events',
  NOTIFICATIONS: 'notifications',
  TELEGRAM: 'telegram',
  WEBHOOKS: 'webhooks',
  ANALYTICS: 'analytics',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly queues = new Map<QueueName, Queue>();
  private readonly prefix: string;

  constructor(private readonly redis: RedisService) {
    this.prefix = loadEnv().QUEUE_PREFIX;
  }

  queue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: this.redis.client,
        prefix: this.prefix,
        defaultJobOptions: {
          attempts: 5,
          // Exponential backoff: a downstream outage must not become a retry storm.
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { age: 3600, count: 1000 },
          // Failed jobs are kept for a week so they can actually be inspected.
          removeOnFail: { age: 7 * 24 * 3600 },
        },
      });
      this.queues.set(name, queue);
    }
    return queue;
  }

  async add<T extends object>(
    name: QueueName,
    jobName: string,
    data: T,
    options?: JobsOptions,
  ): Promise<void> {
    try {
      await this.queue(name).add(jobName, data, options);
    } catch (error) {
      // A queue failure must not roll back a committed business transaction. The outbox
      // is the safety net: the dispatcher will pick the event up on its next sweep.
      logger.error({ err: error, queue: name, jobName }, 'Failed to enqueue job');
    }
  }

  /**
   * Schedules a job for a future instant, used for booking reminders.
   * `jobId` makes rescheduling idempotent — adding the same id twice is a no-op.
   */
  async schedule<T extends object>(
    name: QueueName,
    jobName: string,
    data: T,
    runAt: Date,
    jobId: string,
  ): Promise<void> {
    const delay = Math.max(0, runAt.getTime() - Date.now());
    await this.add(name, jobName, data, { delay, jobId });
  }

  async cancel(name: QueueName, jobId: string): Promise<void> {
    const job = await this.queue(name).getJob(jobId);
    await job?.remove();
  }

  async onModuleDestroy() {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
