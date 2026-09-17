import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The tenant a unit of work belongs to.
 *
 * Set exactly once per request by the authorization guard, and by the worker per job.
 * Nothing downstream can forge it, because request input never reaches this object —
 * that is the whole point (docs/architecture/02-tenant-isolation.md, layer ③).
 */
export interface TenantContextValue {
  tenantId: string;
  /** Who is acting, for audit trails and row-level scoping. */
  actor?: {
    userId?: string;
    customerId?: string;
    role?: string;
    type: 'USER' | 'CUSTOMER' | 'SYSTEM' | 'BOT';
  };
  requestId?: string;
}

/**
 * Deliberate, audited escape from tenant scoping. Used by exactly three callers:
 * the platform admin surface, the Telegram gateway (which must resolve a bot before a
 * tenant exists in context), and migrations/seeds.
 */
export interface SystemContextValue {
  system: true;
  reason: string;
  requestId?: string;
}

type ContextValue = TenantContextValue | SystemContextValue;

const storage = new AsyncLocalStorage<ContextValue>();

export function isSystemContext(value: ContextValue | undefined): value is SystemContextValue {
  return value !== undefined && 'system' in value && value.system === true;
}

export const tenantContext = {
  /**
   * Runs `fn` with the given tenant in scope.
   *
   * Always `await`s inside the storage scope, and that is not incidental. Prisma returns
   * a *lazy* `PrismaPromise`: the query is only sent when something calls `.then()`. With
   * a plain `storage.run(value, () => prisma.x.findMany())`, `run` returns the unexecuted
   * promise and restores the previous context before the query ever leaves — so the guard
   * would see no tenant and the call would fail (or, far worse under a different design,
   * run unscoped). Awaiting here keeps the store active for the continuation, which makes
   * the safe thing the default rather than something every caller has to remember.
   */
  async run<T>(value: TenantContextValue, fn: () => T | Promise<T>): Promise<T> {
    return storage.run(value, async () => await fn());
  },

  /**
   * Runs `fn` with tenant scoping disabled. The reason is required and is written to the
   * audit log when this is used on a route serving a human.
   */
  async runAsSystem<T>(reason: string, fn: () => T | Promise<T>, requestId?: string): Promise<T> {
    return storage.run({ system: true, reason, requestId }, async () => await fn());
  },

  /**
   * Raw synchronous entry, for callers that must return a non-promise from inside the
   * scope — Nest middleware handing off to `next()`, or an interceptor returning an
   * Observable.
   *
   * Carries the lazy-promise hazard described above: anything deferred past the
   * synchronous return loses the context. Prefer `run` unless you have a specific reason.
   */
  runSync<T>(value: ContextValue, fn: () => T): T {
    return storage.run(value, fn);
  },

  get(): ContextValue | undefined {
    return storage.getStore();
  },

  /** The current tenant id, or undefined in system context / outside any context. */
  tenantId(): string | undefined {
    const store = storage.getStore();
    return store && !isSystemContext(store) ? store.tenantId : undefined;
  },

  actor(): TenantContextValue['actor'] {
    const store = storage.getStore();
    return store && !isSystemContext(store) ? store.actor : undefined;
  },

  requestId(): string | undefined {
    return storage.getStore()?.requestId;
  },

  isSystem(): boolean {
    return isSystemContext(storage.getStore());
  },
};
