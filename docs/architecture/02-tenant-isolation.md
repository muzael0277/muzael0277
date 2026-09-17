# Tenant Isolation

> A cross-tenant data leak is the one bug that ends a B2B SaaS company.
> This document is the contract. Read it before writing any query.

## 1. Model: shared schema, row-level `tenantId`

Rejected alternatives (see ADR-0003): schema-per-tenant (migration cost is O(tenants),
connection pool thrash), database-per-tenant (cost-prohibitive for a Uzbek SMB price
point). We use one schema with `tenantId` on every business row.

That choice puts the entire burden on **never forgetting a `WHERE tenantId = …`**.
So we make forgetting impossible rather than discouraged.

## 2. Four layers of defence

```
 ①  Authentication   → who is this, and which tenants may they touch?
 ②  Authorization    → TenantGuard resolves :tenantId → membership → 403 if none
 ③  Context          → AsyncLocalStorage carries the resolved tenantId
 ④  Data access      → Prisma extension injects/validates tenantId on EVERY query
```

A bug must defeat **all four** to leak data. Layer ④ is the one that catches human error.

### ① Authentication

- Staff: JWT access token (15 min) + rotating refresh token (30 d, hashed in DB).
  The access token contains `sub`, `platformRole` and **nothing tenant-specific** —
  memberships are resolved per request so a revoked membership takes effect immediately.
- Customers (Mini App / bot): a separate token audience (`aud: "customer"`) carrying
  `tenantId` + `customerId`. A customer token is rejected by every staff route and
  vice-versa — enforced by audience check, not by route naming.

### ② `TenantGuard`

Runs before every controller in the tenant-scoped API surface. It:

1. reads the tenant from `X-Tenant-Id` header or `:tenantId` route param or the
   customer token,
2. loads `TenantMembership(userId, tenantId)`; `403 NOT_A_MEMBER` when absent,
3. rejects suspended/deleted tenants,
4. stores `{ tenantId, userId, role, membershipId }` in the request.

### ③ `TenantContext` (AsyncLocalStorage)

```ts
tenantContext.run({ tenantId, actor }, () => handler());
```

Set once by the guard, readable anywhere downstream without prop-drilling, and — crucially
— **not forgeable by request input**, because only the guard writes it.

### ④ The Prisma tenant guard extension

This is the load-bearing piece. `packages/database/src/tenant-guard.ts` wraps every
Prisma operation:

| Operation                                                    | Behaviour on a tenant-scoped model                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `findMany` / `findFirst` / `count` / `aggregate` / `groupBy` | `where` is rewritten to `AND [ {tenantId}, originalWhere ]`                                                              |
| `findUnique`                                                 | promoted to `findFirst` with the tenant filter merged (a bare unique id must not be enough to read another tenant's row) |
| `create` / `createMany`                                      | `tenantId` injected; if the caller supplied a _different_ one → `CrossTenantWriteError`                                  |
| `update` / `delete` / `upsert`                               | promoted to the `Many` form with the tenant filter, so a wrong id affects 0 rows instead of someone else's row           |
| any of the above with **no** tenant in context               | `MissingTenantContextError` — fail closed                                                                                |

Two escape hatches, both deliberate and both loud:

```ts
prisma.$system('reason'); // audited, logs the reason; for the platform admin surface,
// the telegram gateway (resolves bot → tenant) and migrations
prisma.$forTenant(id, fn); // explicit tenant switch for the worker, which has no request
```

`$system` writes an `AuditLog` entry when used on a route serving a human.

### Defence in depth: PostgreSQL RLS (Phase 3 hardening)

The extension protects the app. RLS protects against the app being wrong. Migration
`add_rls` (scheduled for Phase 3, ADR-0003) adds per-table policies keyed on
`current_setting('bizbot.tenant_id')`, set by the same context that feeds the extension.
It is deliberately _not_ in MVP: with a pooled connection, a missed `SET LOCAL` becomes an
outage rather than a leak, and we want the extension + tests proven first.

## 3. The subtler leak: foreign keys

The nastier bug is not `SELECT`, it is **creating a relationship into another tenant**:

```
POST /v1/orders { customerId: "<tenant B's customer>" }
```

Row-level filters on the _order_ do not help; the order is written under tenant A, but it
points at B's customer. Defences:

1. **Referenced-entity validation.** Any service accepting a foreign id resolves it
   through the tenant-scoped client first (`this.customers.getOrThrow(customerId)` —
   which already carries the tenant filter) and uses the _loaded_ entity, never the raw id.
2. **Composite foreign keys where it matters.** Hot relationships
   (`OrderItem → Product`, `Booking → Resource`, `CartItem → Variant`) are declared with
   `(tenantId, id)` composite references so the database itself rejects a cross-tenant
   link.
3. **Test coverage.** `tenant-isolation.spec.ts` asserts each of read / update / delete /
   _relate_ across tenants fails.

## 4. Rules for contributors

- **Never** import `PrismaClient` directly in a domain service. Inject `PrismaService`,
  which is always the guarded client.
- **Never** build a raw query with `$queryRawUnsafe` containing a tenant id via string
  interpolation. Use `Prisma.sql` parameters; raw queries must still include the tenant
  predicate, and are code-review gated.
- **Never** trust an id from the request body. Load it, then use the loaded row.
- **Never** widen a scope "temporarily" with `$system` to fix a bug. If a query needs
  cross-tenant reach, it belongs on the platform-admin surface.

## 5. What is intentionally not tenant-scoped

`User`, `Profile`, `Plan`, `PlanFeature`, `BusinessTemplate`, `FeatureFlag`,
`ProcessedWebhook`, `DomainEvent` (has `tenantId` but is read by the worker via
`$forTenant`). These are registered in `NON_TENANT_MODELS` in the extension; adding a
model to that list requires a reviewer and a comment explaining why.
