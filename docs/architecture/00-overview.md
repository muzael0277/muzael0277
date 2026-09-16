# BizBot OS — Architecture Overview

> Telegram-first Business Operating System for Uzbekistan.
> One codebase, many business types, configured — not forked.

## 1. The core thesis

A restaurant, a barbershop and a clinic are not three different products. They are
**the same product with different modules enabled, different templates applied and
different custom fields defined**. The architecture below exists to make that true
in code, not just in marketing.

```
BUSINESS TEMPLATE + MODULES + CONFIGURATION + CUSTOM FIELDS + AUTOMATIONS
                          = CUSTOM BUSINESS SYSTEM
```

Launching a new vertical must not require a source change. It requires:
1. a `BusinessTemplate` row (module preset + default settings + seed content),
2. optional `CustomFieldDefinition` rows,
3. optional `Automation` rows (Phase 4).

If a vertical cannot be expressed that way, the extension point is missing — that is
an architecture bug, and it is fixed by adding the extension point, never by forking
a second app.

## 2. Shape of the system

Five surfaces, one backend, one domain model.

| Surface | App | Audience | Auth |
|---|---|---|---|
| Public website | `apps/web` | Prospects | none |
| Auth + onboarding | `apps/admin` (`/auth`, `/onboarding`) | Business owner | staff session |
| Business dashboard | `apps/admin` | Owner/staff | staff session (JWT + refresh rotation) |
| Telegram Mini App | `apps/miniapp` | End customer | Telegram `initData` → customer session |
| Platform super admin | `apps/admin` (`/platform`) | Us | staff session + `platformRole` |

Backend: **one NestJS modular monolith** (`apps/api`), plus the **same codebase**
booted as a worker process (`apps/api/src/main.worker.ts`). Not a second service —
the same DI container, same domain services, different entrypoint. See ADR-0001.

```
                    ┌──────────────────────────────────────────┐
  Telegram  ───────▶│  /v1/telegram/webhook/:secret            │
  (N bots)          │  gateway: resolve bot → tenant → route   │
                    ├──────────────────────────────────────────┤
  Mini App  ───────▶│  /v1/shop/*      (customer session)      │
  Admin SPA ───────▶│  /v1/*           (staff session + RBAC)  │
  Payments  ───────▶│  /v1/payments/webhook/:provider/:id      │
  Public    ───────▶│  /v1/public/*                            │
                    └───────────────┬──────────────────────────┘
                                    │  thin controllers
                    ┌───────────────▼──────────────────────────┐
                    │  DOMAIN SERVICES  (the actual product)   │
                    │  orders · bookings · catalog · crm ·     │
                    │  loyalty · promotions · inventory ·      │
                    │  payments · notifications · analytics    │
                    └───────────────┬──────────────────────────┘
                                    │
             ┌──────────────────────┼─────────────────────┐
             ▼                      ▼                     ▼
      PostgreSQL 16          Outbox (DomainEvent)      Redis
      + tenant guard          → BullMQ → worker        cache/locks/queues
```

## 3. Non-negotiable invariants

These are enforced in code and covered by tests. Breaking one is a P0.

| # | Invariant | Enforced by | Test |
|---|---|---|---|
| I1 | Tenant A can never read/write Tenant B data | Prisma tenant-guard extension + `TenantContext` + guards | `tenant-isolation.spec` |
| I2 | Money is never trusted from the client | `PricingService` recomputes every total server-side | `checkout-pricing.spec` |
| I3 | A resource cannot be double-booked | `SELECT … FOR UPDATE` on the resource-day lock row inside the booking tx | `booking-collision.spec` |
| I4 | A payment webhook replay changes nothing | `ProcessedWebhook` unique key + idempotent state machine | `payment-idempotency.spec` |
| I5 | Loyalty balance always equals the sum of its ledger | Balance is only ever written with a `LoyaltyTransaction` in the same tx | `loyalty-ledger.spec` |
| I6 | Orders keep a snapshot of what was sold | `OrderItem` copies name/price/modifiers at creation | `order-snapshot.spec` |
| I7 | Secrets are never returned to any client | `Integration.secretRef` → `SecretVault` (AES-256-GCM), never serialized | `secret-exposure.spec` |
| I8 | Permission checks happen server-side | `PermissionsGuard` on every non-public route | `rbac.spec` |

## 4. Layering rules

```
controller  →  application service  →  domain service  →  repository/Prisma
     (thin)        (orchestration,        (rules,            (data access,
                    transactions)          invariants)        tenant-scoped)
```

* Controllers: validate input (zod), call one service method, map to a DTO. No `prisma` import.
* Domain services never import `@nestjs/common` HTTP primitives. They throw typed
  `DomainError`s; an exception filter maps them to HTTP.
* Cross-domain communication goes through **domain events**, not direct service calls,
  whenever the relationship is "and also" rather than "in order to".
  * `createOrder` → *must* reserve stock → direct call, same transaction.
  * `order.completed` → *and also* credit loyalty, notify customer, fire webhooks →
    event.
* Telegram, payments and any third party live behind adapters in `packages/*`. A domain
  service never knows Click exists.

## 5. Module system

A tenant enables modules (`TenantModule`). Everything adapts:
navigation, dashboard widgets, Mini App tabs, API surface, seed content.

`@RequireModule(Module.BOOKING)` on a controller returns `403 MODULE_DISABLED` when
the tenant has not enabled it, so a disabled module is genuinely off — not just hidden
in the UI.

See `05-modules-and-templates.md`.

## 6. Where extensibility lives

| Future capability | The hook that already exists in MVP |
|---|---|
| Automations (trigger→condition→action) | `DomainEvent` outbox — every business fact is already an event |
| Tenant webhooks | Same outbox + `Webhook`/`WebhookDelivery` |
| AI assistant | Domain services are already tool-shaped (`searchProducts`, `getAvailability`, …) and read from the DB, never invent facts |
| POS | Shares `Order`/`Payment`/`Inventory`/`Customer` — no second database |
| Marketplace / plugins | `Integration` is generic (`type` + `provider` + `config` + `secretRef`), payments are just the first consumer |
| White label | `Tenant.primaryColor` / `logoUrl` / `slug` already drive theming |
| Custom workflows | `OrderStatusHistory` + a status pipeline resolved from template config, not a hard-coded enum path |
| Plans & limits | `Plan` → `PlanFeature` → `Subscription` → `EntitlementService.can(tenant, feature)` |

## 7. What MVP deliberately does not build

Full accounting, payroll, full POS, visual workflow builder, marketplace, white-label
provisioning, native apps, WhatsApp, advanced logistics. Each has a named extension
point above so it can be added without a rewrite.

## 8. Reading order

1. `01-domain-model.md` — entities and why they are shaped that way
2. `02-tenant-isolation.md` — the single most important document here
3. `03-rbac-permissions.md`
4. `05-modules-and-templates.md`
5. `06-domain-events.md`
6. `09-booking-engine.md`, `08-payments.md`, `07-telegram.md`
7. `12-mvp-phases.md`, `13-technical-risks.md`
