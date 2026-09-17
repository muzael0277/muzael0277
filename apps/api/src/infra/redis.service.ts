import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { loadEnv } from '@bizbot/config';
import { logger } from '../common/logger';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor() {
    const env = loadEnv();
    this.client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null, // required by BullMQ
      lazyConnect: false,
    });
    this.client.on('error', (error) => logger.error({ err: error }, 'Redis error'));
  }

  async onModuleDestroy() {
    await this.client.quit();
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  /** Cache-aside with a TTL. Returns the fresh value on a cache miss or a parse failure. */
  async remember<T>(key: string, ttlSeconds: number, produce: () => Promise<T>): Promise<T> {
    try {
      const cached = await this.client.get(key);
      if (cached !== null) return JSON.parse(cached) as T;
    } catch (error) {
      logger.warn({ err: error, key }, 'Cache read failed; falling through to source');
    }

    const value = await produce();
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (error) {
      // A cache write failure must never fail the request.
      logger.warn({ err: error, key }, 'Cache write failed');
    }
    return value;
  }

  async forget(...keys: string[]): Promise<void> {
    if (keys.length > 0) await this.client.del(...keys);
  }

  async forgetPrefix(prefix: string): Promise<void> {
    // SCAN rather than KEYS: KEYS blocks the server, and this runs on tenant updates.
    let cursor = '0';
    do {
      const [next, found] = await this.client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      if (found.length > 0) await this.client.del(...found);
    } while (cursor !== '0');
  }
}
