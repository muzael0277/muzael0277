import { Prisma, PrismaClient } from '@prisma/client';
import { tenantContext, isSystemContext } from './tenant-context';
import { CrossTenantWriteError, MissingTenantContextError, RecordNotFoundError } from './errors';

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

/**
 * The Tenant row *is* the tenant, so its tenant key is its own primary key rather than a
 * `tenantId` column. Without this it falls outside the guard entirely, and
 * `prisma.tenant.findFirst()` quietly returns whichever tenant happens to be first in the
 * table — which is how a booking service ended up reading another business's timezone and
 * settings. The write was refused by the guard, but the read had already gone wrong.
 */
const TENANT_KEY_BY_MODEL: Record<string, string> = {
  Tenant: 'id',
};

function tenantKeyFor(model: string): string {
  return TENANT_KEY_BY_MODEL[model] ?? 'tenantId';
}

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
    const key = tenantKeyFor(model.name);
    if (model.fields.some((f) => f.name === key)) scoped.add(model.name);
  }
  // Models with an explicit tenant key are always scoped, even if the key is not
  // literally called tenantId.
  for (const model of Object.keys(TENANT_KEY_BY_MODEL)) scoped.add(model);
  return scoped;
}

const READ_OPERATIONS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);
const UNIQUE_READ_OPERATIONS = new Set(['findUnique', 'findUniqueOrThrow']);
/**
 * Singular writes take a *unique* where clause. Prisma rejects an `AND` wrapper there,
 * so these get the tenant merged as a plain field instead — semantically identical,
 * since Prisma ANDs every top-level key in a where.
 */
const UNIQUE_WRITE_OPERATIONS = new Set(['update', 'delete', 'upsert']);
const BULK_WRITE_OPERATIONS = new Set(['updateMany', 'deleteMany', 'updateManyAndReturn']);
const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

type AnyArgs = Record<string, unknown> & {
  where?: Record<string, unknown>;
  data?: Record<string, unknown> | Record<string, unknown>[];
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
};

/**
 * Refuses a where clause that names a different tenant.
 *
 * A composite unique like `{ tenantId_module: { tenantId: <other>, module: 'ORDERS' } }`
 * would otherwise match nothing and fall through to an upsert's `create` — quietly
 * producing a row in the *caller's* tenant when they asked for someone else's. No data
 * leaks, but the caller's intent was cross-tenant and silently doing something else is
 * worse than failing. Caught by a test rather than by review.
 */
function assertWhereTenant(
  where: unknown,
  tenantId: string,
  model: string,
  operation: string,
  tenantKey = 'tenantId',
  depth = 0,
): void {
  if (depth > 3 || where === null || typeof where !== 'object') return;

  const entries = Object.entries(where as Record<string, unknown>);

  // The model's own tenant key, checked at the top level. For Tenant that key is `id`,
  // and this check is what stops the merge below from silently *redirecting* an update
  // aimed at another tenant onto the caller's own row — which is worse than failing,
  // because the caller believes they edited something else.
  if (depth === 0) {
    const supplied = (where as Record<string, unknown>)[tenantKey];
    if (typeof supplied === 'string' && supplied !== tenantId) {
      throw new CrossTenantWriteError(model, operation, tenantId, supplied);
    }
  }

  for (const [key, value] of entries) {
    if (key === 'tenantId' && typeof value === 'string' && value !== tenantId) {
      throw new CrossTenantWriteError(model, operation, tenantId, value);
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      assertWhereTenant(value, tenantId, model, operation, tenantKey, depth + 1);
    }
  }
}

/**
 * Merges the tenant into a unique where clause.
 *
 * `tenantId` is applied last so a caller-supplied value cannot override it, and the
 * clause stays a valid WhereUniqueInput — which `AND` would not be.
 */
function withTenantUniqueWhere(
  where: Record<string, unknown> | undefined,
  tenantId: string,
  key: string,
): Record<string, unknown> {
  return { ...(where ?? {}), [key]: tenantId };
}

/** Merges the tenant predicate with whatever the caller asked for, without clobbering it. */
function withTenantWhere(
  where: Record<string, unknown> | undefined,
  tenantId: string,
  key: string,
): Record<string, unknown> {
  if (!where || Object.keys(where).length === 0) return { [key]: tenantId };
  // AND rather than spread: a caller-supplied tenant key or `OR` must not be able to
  // widen the scope, and a plain spread would let an `OR` clause escape it.
  return { AND: [{ [key]: tenantId }, where] };
}

/**
 * Relation field -> related model, built from the schema.
 *
 * Needed to stamp nested writes: `product.create({ data: { modifierGroups: { create: [...] } } })`
 * writes rows in a *different* table, and those rows need the tenant too.
 */
const RELATION_TARGETS: Map<string, Map<string, string>> = (() => {
  const map = new Map<string, Map<string, string>>();
  for (const model of Prisma.dmmf.datamodel.models) {
    const relations = new Map<string, string>();
    for (const field of model.fields) {
      if (field.kind === 'object' && typeof field.type === 'string') {
        relations.set(field.name, field.type);
      }
    }
    map.set(model.name, relations);
  }
  return map;
})();

const NESTED_CREATE_KEYS = ['create', 'createMany', 'connectOrCreate', 'upsert'] as const;

/**
 * Stamps the tenant onto nested creates.
 *
 * Without this, a nested write fails with a bare "Argument `tenantId` is missing" — or,
 * far worse on a model where tenantId happened to be optional, succeeds with no tenant at
 * all. Every call site would otherwise have to remember to thread the tenant through by
 * hand, which is exactly the kind of thing that gets forgotten once and leaks.
 *
 * Depth-limited: Prisma allows arbitrarily deep nesting, but two levels covers every
 * write this application makes, and an unbounded walk over attacker-influenced input is
 * its own hazard.
 */
function stampNestedCreates(
  model: string,
  data: Record<string, unknown>,
  tenantId: string,
  depth = 0,
  operation = 'create',
): Record<string, unknown> {
  if (depth > 2) return data;

  const relations = RELATION_TARGETS.get(model);
  if (!relations) return data;

  const result: Record<string, unknown> = { ...data };

  for (const [field, value] of Object.entries(data)) {
    const relatedModel = relations.get(field);
    if (!relatedModel || value === null || typeof value !== 'object') continue;
    if (!scopedModelsCache?.has(relatedModel)) continue;

    const relatedKey = tenantKeyFor(relatedModel);
    // The Tenant model's key is its own id and must never be auto-stamped.
    if (relatedKey === 'id') continue;

    const nested = { ...(value as Record<string, unknown>) };
    let touched = false;

    for (const key of NESTED_CREATE_KEYS) {
      const payload = nested[key];
      if (payload === undefined || payload === null) continue;

      if (Array.isArray(payload)) {
        nested[key] = payload.map((row) =>
          typeof row === 'object' && row !== null
            ? stampNestedCreates(
                relatedModel,
                stampRow(
                  relatedModel,
                  row as Record<string, unknown>,
                  relatedKey,
                  tenantId,
                  operation,
                ),
                tenantId,
                depth + 1,
                operation,
              )
            : row,
        );
        touched = true;
      } else if (typeof payload === 'object') {
        const row = payload as Record<string, unknown>;
        // createMany wraps its rows in { data: [...] }
        if (key === 'createMany' && Array.isArray(row.data)) {
          nested[key] = {
            ...row,
            data: (row.data as unknown[]).map((entry) =>
              typeof entry === 'object' && entry !== null
                ? stampRow(
                    relatedModel,
                    entry as Record<string, unknown>,
                    relatedKey,
                    tenantId,
                    operation,
                  )
                : entry,
            ),
          };
        } else {
          nested[key] = stampNestedCreates(
            relatedModel,
            stampRow(relatedModel, row, relatedKey, tenantId, operation),
            tenantId,
            depth + 1,
            operation,
          );
        }
        touched = true;
      }
    }

    if (touched) result[field] = nested;
  }

  return result;
}

/**
 * Applies the tenant to one nested row, refusing a row that names a different one.
 *
 * The stamp is applied *after* the caller's fields, not before: spreading the caller last
 * would let a nested `tenantId` silently override ours and write into another tenant —
 * which is exactly what a test caught here.
 */
function stampRow(
  model: string,
  row: Record<string, unknown>,
  key: string,
  tenantId: string,
  operation: string,
): Record<string, unknown> {
  const supplied = row[key];
  if (supplied !== undefined && supplied !== null && supplied !== tenantId) {
    throw new CrossTenantWriteError(model, `${operation} (nested)`, tenantId, String(supplied));
  }
  return { ...row, [key]: tenantId };
}

/** Populated once at guard construction; nested stamping consults it. */
let scopedModelsCache: Set<string> | undefined;

function assertTenantOnData(
  data: Record<string, unknown>,
  tenantId: string,
  model: string,
  operation: string,
  key: string,
): Record<string, unknown> {
  // Creating a Tenant is how a tenant comes into existence, so its own id must not be
  // stamped with the current context. That path runs in system context anyway.
  if (key === 'id') return stampNestedCreates(model, data, tenantId, 0, operation);

  const supplied = data[key];
  if (supplied !== undefined && supplied !== null && supplied !== tenantId) {
    throw new CrossTenantWriteError(model, operation, tenantId, String(supplied));
  }

  return stampNestedCreates(model, { ...data, [key]: tenantId }, tenantId, 0, operation);
}

export function applyTenantGuard<T extends PrismaClient>(client: T) {
  const scopedModels = buildScopedModelSet();
  scopedModelsCache = scopedModels;

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
          const key = tenantKeyFor(model);
          const a = (args ?? {}) as AnyArgs;

          if (READ_OPERATIONS.has(operation)) {
            return query({ ...a, where: withTenantWhere(a.where, tenantId, key) });
          }

          if (UNIQUE_READ_OPERATIONS.has(operation)) {
            // Prisma's extended-where-unique accepts additional scalar filters alongside
            // the unique one, so the tenant is merged in place rather than the call being
            // promoted to findFirst on the outer client. That promotion worked, but it
            // ran the query *outside* any enclosing transaction — so a read-then-write
            // inside one could miss its own uncommitted changes. Merging keeps the call
            // exactly where the caller put it.
            //
            // An id belonging to another tenant now yields null, or a not-found throw,
            // instead of that tenant's row: possessing an id is not a capability.
            // A read naming another tenant's key is simply *not found* — that is the
            // honest answer and the one a REST handler should turn into a 404. Throwing
            // here would surface someone pasting a foreign id as a 500. Writes are
            // different: attempting to write another tenant is a bug worth surfacing
            // loudly, so those still raise CrossTenantWriteError below.
            const namedTenant = (a.where ?? {})[key];
            if (typeof namedTenant === 'string' && namedTenant !== tenantId) {
              if (operation === 'findUnique') return null;
              throw new RecordNotFoundError(model);
            }
            return query({ ...a, where: withTenantUniqueWhere(a.where, tenantId, key) });
          }

          if (UNIQUE_WRITE_OPERATIONS.has(operation)) {
            assertWhereTenant(a.where, tenantId, model, operation, key);
            const next: AnyArgs = { ...a, where: withTenantUniqueWhere(a.where, tenantId, key) };
            if (operation === 'upsert' && a.create && !Array.isArray(a.create)) {
              next.create = assertTenantOnData(a.create, tenantId, model, operation, key);
            }
            return query(next);
          }

          if (BULK_WRITE_OPERATIONS.has(operation)) {
            return query({ ...a, where: withTenantWhere(a.where, tenantId, key) });
          }

          if (CREATE_OPERATIONS.has(operation)) {
            if (Array.isArray(a.data)) {
              return query({
                ...a,
                data: a.data.map((row) => assertTenantOnData(row, tenantId, model, operation, key)),
              });
            }
            if (a.data && typeof a.data === 'object') {
              return query({
                ...a,
                data: assertTenantOnData(
                  a.data as Record<string, unknown>,
                  tenantId,
                  model,
                  operation,
                  key,
                ),
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

/** Exposed for tests and for the boot-time self-check. */
export const tenantGuardInternals = {
  tenantKeyFor,
  buildScopedModelSet,
  withTenantWhere,
  withTenantUniqueWhere,
  assertWhereTenant,
  EXPLICITLY_UNSCOPED,
};
