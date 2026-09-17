import { Prisma, PrismaClient } from '@prisma/client';
import { tenantContext, isSystemContext } from './tenant-context';
import { CrossTenantWriteError, MissingTenantContextError } from './errors';

/**
 * The tenant guard.
 *
 * Layer ④ of tenant isolation, and the one that catches human error: it rewrites every
 * Prisma operation so that forgetting `WHERE tenantId = …` is impossible rather than
 * merely discouraged. Read docs/architecture/02-tenant-isolation.md before changing it.
 *
 * Design notes:
 *
 *  • The set of guarded models is derived from the schema at runtime (any model with a
 *    `tenantId` field), not hand-maintained. A new tenant-scoped model is therefore
 *    protected the moment it is added, with no chance of someone forgetting to register
 *    it — which is exactly the failure mode this guard exists to prevent.
 *
 *  • `findUnique` is promoted to `findFirst` so that possessing a row id is not by
 *    itself a capability. This is the single most commonly missed isolation hole.
 *
 *  • Writes fail closed. No tenant in context means the operation is refused, not run
 *    unscoped.
 */

/** Models the guard must not scope, even though they may carry a tenantId. */
const EXPLICITLY_UNSCOPED = new Set<string>([
  // Idempotency and dedup tables are consulted by the webhook gateway *before* a tenant
  // is known — that is their whole purpose. They carry no business data.
  'ProcessedWebhook',
]);

function buildScopedModelSet(): Set<string> {
  const scoped = new Set<string>();
  for (const model of Prisma.dmmf.datamodel.models) {
    if (EXPLICITLY_UNSCOPED.has(model.name)) continue;
    if (model.fields.some((f) => f.name === 'tenantId')) scoped.add(model.name);
  }
  return scoped;
}

const READ_OPERATIONS = new Set([
  'findMany', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy',
]);
const UNIQUE_READ_OPERATIONS = new Set(['findUnique', 'findUniqueOrThrow']);
const WRITE_WHERE_OPERATIONS = new Set([
  'update', 'updateMany', 'delete', 'deleteMany', 'upsert', 'updateManyAndReturn',
]);
const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

type AnyArgs = Record<string, unknown> & {
  where?: Record<string, unknown>;
  data?: Record<string, unknown> | Record<string, unknown>[];
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
};

/** Merges the tenant predicate with whatever the caller asked for, without clobbering it. */
function withTenantWhere(
  where: Record<string, unknown> | undefined,
  tenantId: string,
): Record<string, unknown> {
  if (!where || Object.keys(where).length === 0) return { tenantId };
  // AND rather than spread: a caller-supplied `tenantId` or `OR` must not be able to
  // widen the scope, and `{...where, tenantId}` would let an `OR` clause escape it.
  return { AND: [{ tenantId }, where] };
}

function assertTenantOnData(
  data: Record<string, unknown>,
  tenantId: string,
  model: string,
  operation: string,
): Record<string, unknown> {
  const supplied = data.tenantId;
  if (supplied === undefined || supplied === null) {
    return { ...data, tenantId };
  }
  if (supplied !== tenantId) {
    throw new CrossTenantWriteError(model, operation, tenantId, String(supplied));
  }
  return data;
}

export function applyTenantGuard<T extends PrismaClient>(client: T) {
  const scopedModels = buildScopedModelSet();

  return client.$extends({
    name: 'bizbot-tenant-guard',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!scopedModels.has(model)) return query(args);

          const context = tenantContext.get();

          // System context is the deliberate, audited escape hatch.
          if (isSystemContext(context)) return query(args);

          if (!context) {
            throw new MissingTenantContextError(model, operation);
          }

          const { tenantId } = context;
          const a = (args ?? {}) as AnyArgs;

          if (READ_OPERATIONS.has(operation)) {
            return query({ ...a, where: withTenantWhere(a.where, tenantId) });
          }

          if (UNIQUE_READ_OPERATIONS.has(operation)) {
            // findUnique cannot take a non-unique filter, so promote it. The return
            // shape is identical, and an id belonging to another tenant now yields null
            // (or a not-found throw) instead of that tenant's row.
            const promoted = operation === 'findUnique' ? 'findFirst' : 'findFirstOrThrow';
            const delegates = client as unknown as Record<
              string,
              Record<string, (args: unknown) => unknown> | undefined
            >;
            const delegate = delegates[lowerFirst(model)];
            const run = delegate?.[promoted];
            if (typeof run !== 'function') {
              // Cannot promote safely, so refuse rather than run an unscoped findUnique.
              throw new MissingTenantContextError(model, `${operation} (no ${promoted} delegate)`);
            }
            return run({ ...a, where: withTenantWhere(a.where, tenantId) });
          }

          if (WRITE_WHERE_OPERATIONS.has(operation)) {
            const next: AnyArgs = { ...a, where: withTenantWhere(a.where, tenantId) };
            if (operation === 'upsert' && a.create && !Array.isArray(a.create)) {
              next.create = assertTenantOnData(a.create, tenantId, model, operation);
            }
            return query(next);
          }

          if (CREATE_OPERATIONS.has(operation)) {
            if (Array.isArray(a.data)) {
              return query({
                ...a,
                data: a.data.map((row) => assertTenantOnData(row, tenantId, model, operation)),
              });
            }
            if (a.data && typeof a.data === 'object') {
              return query({
                ...a,
                data: assertTenantOnData(a.data as Record<string, unknown>, tenantId, model, operation),
              });
            }
            return query(a);
          }

          // Anything unrecognised (a future Prisma operation) fails closed rather than
          // running unscoped.
          throw new MissingTenantContextError(model, `${operation} (unhandled by tenant guard)`);
        },
      },
    },
  });
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

/** Exposed for tests and for the boot-time self-check. */
export const tenantGuardInternals = { buildScopedModelSet, withTenantWhere, EXPLICITLY_UNSCOPED };
