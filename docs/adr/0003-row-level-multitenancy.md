# ADR-0003 — Shared schema with row-level `tenantId`

**Status:** Accepted · 2026-09-16

## Context
Three options: database per tenant, schema per tenant, shared schema with a discriminator.
We expect thousands of small tenants at a low ARPU.

## Decision
Shared schema, `tenantId` on every business row, enforced by a Prisma client extension
that injects and validates the tenant filter on **every** operation, backed by
`AsyncLocalStorage` context set by an authorization guard.

## Rationale
* *Database per tenant*: excellent isolation, impossible economics — thousands of
  databases, thousands of connection pools, migrations that take hours.
* *Schema per tenant*: migrations are O(tenants) and Prisma does not model it well.
* *Shared schema*: one migration, one pool, cheap. The cost is that isolation becomes an
  application responsibility — so we make it structural rather than a convention.

## Consequences
* Forgetting the filter must be impossible, not merely discouraged. `findUnique` is
  rewritten to `findFirst` + tenant filter; missing context fails closed; cross-tenant
  writes throw.
* Cross-tenant relationship creation is a distinct threat, handled with
  referenced-entity validation and composite `(tenantId, id)` foreign keys.
* PostgreSQL RLS is planned (Phase 7) as defence in depth, deliberately after the
  extension is proven — with a pooled connection, a missed `SET LOCAL` degrades to an
  outage instead of a leak, and we want tests covering the app layer first.
* A tenant can still be promoted to a dedicated database later: every row already carries
  the shard key.
