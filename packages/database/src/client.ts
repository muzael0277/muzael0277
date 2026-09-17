import { PrismaClient } from '@prisma/client';
import { applyTenantGuard } from './tenant-guard';
import { tenantContext, type TenantContextValue } from './tenant-context';

export type GuardedPrismaClient = ReturnType<typeof applyTenantGuard>;

export interface CreateClientOptions {
  databaseUrl?: string;
  log?: ('query' | 'info' | 'warn' | 'error')[];
}

export function createPrismaClient(options: CreateClientOptions = {}): GuardedPrismaClient {
  const base = new PrismaClient({
    log: options.log ?? (process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error']),
    ...(options.databaseUrl ? { datasources: { db: { url: options.databaseUrl } } } : {}),
  });
  return applyTenantGuard(base);
}

/**
 * Runs `fn` with tenant scoping disabled.
 *
 * Every call must justify itself. Legitimate uses are the platform-admin surface, the
 * Telegram webhook gateway (which resolves bot → tenant before a tenant is in context),
 * payment webhooks (same reason), and seeds/migrations. Using this to "fix" a query that
 * unexpectedly returns nothing is always the wrong answer — the right answer is that the
 * data belongs to a different tenant.
 */
export function asSystem<T>(reason: string, fn: () => T | Promise<T>): Promise<T> {
  return tenantContext.runAsSystem(reason, fn);
}

/** Runs `fn` scoped to an explicit tenant. Used by the worker, which has no request. */
export function forTenant<T>(value: TenantContextValue, fn: () => T | Promise<T>): Promise<T> {
  return tenantContext.run(value, fn);
}
