# Project Structure

```
bizbot-os/
├─ apps/
│  ├─ api/                    NestJS modular monolith (HTTP) + worker entrypoint
│  │  └─ src/
│  │     ├─ main.ts           HTTP bootstrap
│  │     ├─ main.worker.ts    worker bootstrap (same DI container)
│  │     ├─ app.module.ts
│  │     ├─ common/           guards · filters · pipes · decorators · logging · context
│  │     ├─ infra/            prisma · redis · queue · storage · mailer · vault
│  │     └─ modules/          ← one folder per bounded domain
│  │        ├─ auth/  tenants/  members/  customers/  catalog/  services/
│  │        ├─ branches/  employees/  cart/  orders/  bookings/  payments/
│  │        ├─ loyalty/  promotions/  inventory/  analytics/  telegram/
│  │        ├─ notifications/  integrations/  messages/  events/  audit/
│  │        ├─ platform/  shop/  public/  health/
│  ├─ admin/                  Next.js — dashboard, auth, onboarding, super admin
│  ├─ miniapp/                Next.js — Telegram Mini App
│  └─ web/                    Next.js — public marketing site
├─ packages/
│  ├─ database/               Prisma schema · migrations · tenant guard · seed
│  ├─ shared/                 money · phone · errors · result · time · ids
│  ├─ rbac/                   roles · permissions · modules · templates
│  ├─ contracts/              zod DTOs shared by API and frontends
│  ├─ i18n/                   uz · ru · en dictionaries + resolver
│  ├─ telegram/               Bot API client · initData verification · types
│  ├─ payments/               provider interface · cash · click · payme · mock
│  ├─ ui/                     design system (React + Tailwind)
│  └─ config/                 env schema · tsconfig · eslint presets
├─ docs/                      architecture · adr · guides
├─ docker/                    Dockerfiles · nginx · compose overrides
└─ .github/workflows/         ci.yml
```

## Domain folder shape

```
modules/orders/
├─ orders.module.ts
├─ orders.controller.ts        thin — validate, call, map
├─ orders.service.ts           orchestration + transactions
├─ order-pricing.service.ts    pure calculation, heavily unit-tested
├─ order-status.service.ts     state machine
├─ orders.repository.ts        Prisma access (tenant-guarded)
├─ dto/                        zod schemas re-exported from @bizbot/contracts
├─ events/                     handlers this domain subscribes to
└─ __tests__/
```

**Rules.** A domain may import another domain's _service_, never its repository or Prisma
models. Anything shared by three or more domains moves to `packages/shared`. Controllers
never import `PrismaService`. Pure calculation (pricing, availability, loyalty accrual)
lives in dependency-free classes so tests need no database.

## Why a monorepo

zod contracts and permission definitions are shared by the API and three frontends. In
separate repos they drift within a month. `pnpm` workspaces + Turborepo give
content-hash-based caching and a `dev` task that boots everything together.
