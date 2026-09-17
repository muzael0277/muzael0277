import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  PrismaClient,
  applyTenantGuard,
  asSystem,
  type GuardedPrismaClient,
} from '@bizbot/database';
import { loadEnv } from '@bizbot/config';
import { logger } from '../common/logger';

/**
 * The only Prisma client a domain service may touch.
 *
 * It is always the guarded client. Importing PrismaClient directly anywhere in
 * apps/api/src/modules is a review-blocking mistake — that bypasses tenant isolation
 * entirely (docs/architecture/02-tenant-isolation.md).
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly base: PrismaClient;
  /** Guarded: every query is automatically scoped to the request's tenant. */
  readonly client: GuardedPrismaClient;

  constructor() {
    const env = loadEnv();
    this.base = new PrismaClient({
      datasources: { db: { url: env.DATABASE_URL } },
      log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
    this.client = applyTenantGuard(this.base);
  }

  /**
   * The unguarded client. Reachable only through `system()`, which forces a written
   * reason — so every cross-tenant read is greppable and justified.
   */
  get raw(): PrismaClient {
    return this.base;
  }

  /**
   * Runs a callback with tenant scoping disabled.
   *
   * Sanctioned callers: the platform-admin surface, the Telegram gateway and payment
   * webhooks (both must resolve a tenant before one exists in context), and membership
   * lookup during authorization. Using this because a query "returns nothing" is always
   * wrong — the data belongs to another tenant, and that is the guard working.
   */
  system<T>(reason: string, fn: () => T | Promise<T>): Promise<T> {
    return asSystem(reason, fn);
  }

  async onModuleInit() {
    await this.base.$connect();
    logger.info('Database connected');
  }

  async onModuleDestroy() {
    await this.base.$disconnect();
  }

  /** Used by the readiness probe. */
  async ping(): Promise<boolean> {
    try {
      await this.base.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
