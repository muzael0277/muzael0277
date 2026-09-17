# BizBot OS

A Telegram-first business operating system for the Uzbekistan market.

One codebase runs a restaurant, a barbershop, a beauty salon, a clinic, an online
store or an auto service. The difference between them is data, not code:

```
BUSINESS TEMPLATE + MODULES + CONFIGURATION + CUSTOM FIELDS + AUTOMATIONS
                        = CUSTOM BUSINESS SYSTEM
```

Launching a new vertical means a `BusinessTemplate` row, a module preset and
optional custom fields — not a fork and not a new deployment.

---

## What is actually built

This is a working system, not a clickable mock. Every feature listed here reads and
writes real data through the real API.

| Surface                               | Status | What works                                                                           |
| ------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| Public website (`apps/web`)           | ✅     | Landing page generated from the real template and module registries                  |
| Auth + onboarding (`apps/admin/auth`) | ✅     | Register, login, refresh rotation, 8-step onboarding that provisions a tenant        |
| Business dashboard (`apps/admin`)     | ✅     | Dashboard, customers, products, orders, bookings, Telegram, settings, module toggles |
| Telegram Mini App (`apps/miniapp`)    | ✅     | Catalog, cart, checkout, booking, order history — tabs derived from enabled modules  |
| Platform super admin                  | ◻️     | Backend and `platformRole` exist; the UI is not built                                |

Backend modules that are implemented and tested: auth, tenants, members, RBAC,
modules, branches, employees, CRM, catalog, services, cart and pricing, orders,
bookings, loyalty, promotions, inventory, payments, Telegram, notifications, domain
events, analytics, audit, health.

Declared in the domain but not yet built, each with a documented extension point:
marketing campaigns, referrals, POS, AI assistant, the automation builder, outbound
webhooks, white-label theming, and the custom-field admin UI.

## The eight invariants

These are the behaviours that must never regress — the ones where a bug leaks another
business's data, loses money, or double-books a customer. Each is enforced in code and
covered by a test that fails loudly if it breaks.

| #   | Invariant                                      | Enforced by                                                   |
| --- | ---------------------------------------------- | ------------------------------------------------------------- |
| I1  | Tenant A can never read or write Tenant B data | Prisma client extension + `AsyncLocalStorage` tenant context  |
| I2  | Money is never trusted from the client         | `PricingService` recomputes every total server-side           |
| I3  | A resource cannot be double-booked             | `FOR UPDATE` day lock + a GiST exclusion constraint           |
| I4  | A payment webhook replay changes nothing       | `ProcessedWebhook` unique key inside the applying transaction |
| I5  | Loyalty balance equals the sum of its ledger   | Balance is only written alongside a `LoyaltyTransaction`      |
| I6  | Orders keep a snapshot of what was sold        | `OrderItem` copies name, price and modifiers at creation      |
| I7  | Secrets are never returned to any client       | AES-256-GCM vault; `secretRef` is never serialized            |
| I8  | Permission checks happen server-side           | `PermissionsGuard` + a boot-time audit of every route         |

`docs/architecture/00-overview.md` maps each one to its mechanism and its test.

## Quick start

Requires Node 22, pnpm 10, Docker (for Postgres and Redis).

```bash
pnpm install
docker compose up -d postgres redis   # data services only
pnpm setup:env                        # creates .env and links it where it is read
```

Open `.env` and fill in the three blank secrets — the app refuses to boot without
them:

```bash
openssl rand -base64 48   # JWT_ACCESS_SECRET
openssl rand -base64 48   # JWT_REFRESH_SECRET   (must differ from the access one)
openssl rand -hex 32      # SECRETS_ENCRYPTION_KEY
```

Then:

```bash
pnpm db:migrate:deploy    # apply migrations
pnpm db:seed              # three demo businesses with real history
pnpm dev                  # api :4000 · web :3000 · admin :3001 · miniapp :3002
```

Sign in to the admin at http://localhost:3001 with any demo account, password
`BizBotDemo2026`:

| Login              | Business     | Shows off                                    |
| ------------------ | ------------ | -------------------------------------------- |
| `anor@bizbot.uz`   | Anor Cafe    | Restaurant, delivery, menu modifiers, orders |
| `barber@bizbot.uz` | Barber House | Barbershop, 3 masters, online booking        |
| `zebo@bizbot.uz`   | Zebo Beauty  | Salon, 4 masters plus a room resource        |

No Telegram token and no payment credentials are needed: demo tenants use the mock
payment provider and the bot runs in polling mode.

Full walkthrough: **[docs/guides/local-development.md](docs/guides/local-development.md)**.

## Repository layout

```
apps/
  api/        NestJS modular monolith — also booted as the worker
  admin/      Next.js business dashboard
  miniapp/    Next.js Telegram Mini App
  web/        Next.js public site
packages/
  shared/     Money, phone, time, ids — no framework imports
  rbac/       Roles, permissions, modules, business templates
  contracts/  zod schemas shared by the API and every frontend
  database/   Prisma schema, migrations, tenant guard, seed
  i18n/       uz / ru / en dictionaries
  config/     Validated environment schema
  telegram/   Bot client and initData verification
  payments/   Provider adapters (cash, Click, Payme, mock)
  ui/         Design system and Tailwind preset
docker/       Dockerfiles for the API, the worker and the Next apps
docs/         Architecture, ADRs and guides
```

The API is a **modular monolith**, not microservices, and the worker is the same image
with a different entrypoint. The reasoning is in
[ADR-0001](docs/adr/0001-modular-monolith.md).

## Commands

| Command                  | Does                                                    |
| ------------------------ | ------------------------------------------------------- |
| `pnpm dev`               | All four apps in watch mode                             |
| `pnpm build`             | Build every package and app                             |
| `pnpm test`              | 224 tests — unit, tenant guard, and the invariant suite |
| `pnpm lint`              | Prettier check plus TypeScript across the workspace     |
| `pnpm db:migrate`        | Create a migration from a schema change                 |
| `pnpm db:migrate:deploy` | Apply pending migrations (this is what production runs) |
| `pnpm db:seed`           | Load or refresh the three demo businesses               |
| `pnpm db:check`          | Verify stored data against the invariants               |
| `pnpm setup:env`         | Create `.env` and link it where it is read              |

## Documentation

**Guides** — how to do a thing:

- [Local development](docs/guides/local-development.md)
- [Environment variables](docs/guides/environment.md)
- [Database migrations](docs/guides/migrations.md)
- [Telegram integration](docs/guides/telegram.md)
- [Payment integration](docs/guides/payments.md)
- [Testing](docs/guides/testing.md)
- [Deployment](docs/guides/deployment.md)

**Architecture** — why it is built this way:

- [Overview and invariants](docs/architecture/00-overview.md)
- [Domain model](docs/architecture/01-domain-model.md)
- [Tenant isolation](docs/architecture/02-tenant-isolation.md)
- [RBAC and permissions](docs/architecture/03-rbac-permissions.md)
- [API boundaries](docs/architecture/04-api-boundaries.md)
- [Modules and templates](docs/architecture/05-modules-and-templates.md)
- [Domain events](docs/architecture/06-domain-events.md)
- [Telegram](docs/architecture/07-telegram.md) ·
  [Payments](docs/architecture/08-payments.md) ·
  [Booking engine](docs/architecture/09-booking-engine.md)
- [Security](docs/architecture/10-security.md) ·
  [Project structure](docs/architecture/11-project-structure.md)
- [MVP phases](docs/architecture/12-mvp-phases.md) ·
  [Technical risks](docs/architecture/13-technical-risks.md)
- [Decision records](docs/adr/)

## Localization

Uzbek is the default, Russian is fully supported, English is wired up and partially
translated. Nothing is hard-coded: strings live in `packages/i18n`, money is formatted
as `150 000 so'm`, phones as `+998 90 123 45 67`, and every timestamp is stored in UTC
and rendered in the tenant's timezone (`Asia/Tashkent` by default).

## License

Proprietary. All rights reserved.
