# MVP Implementation Phases

Rule: **the application runs and its tests pass at the end of every phase.** No phase
leaves the tree in a state where `pnpm build && pnpm test` fails.

## Phase 0 — Architecture ✅

These documents + ADRs. Bounded modules, schema, permissions, isolation strategy, API
boundaries, project structure, risks.

## Phase 1 — Foundation ✅

Monorepo, TypeScript project references, lint/format, `packages/shared`, `packages/rbac`
(roles, permissions, modules, templates), `packages/i18n`, `packages/contracts`,
`packages/config` with a validated env schema.
_Exit:_ `pnpm build` green, permission matrix unit-tested.

## Phase 2 — Data ✅

Full Prisma schema, migrations against real Postgres, the tenant-guard client extension,
`SecretVault`, demo seed (Anor Cafe · Barber House · Zebo Beauty).
_Exit:_ migrations apply cleanly; tenant-guard unit tests pass; seed produces three
browsable businesses.

## Phase 3 — API core ✅

Nest bootstrap, structured logging with request ids, error filter and error codes,
health/readiness, auth (register/login/refresh rotation/logout), tenants, onboarding,
memberships, `TenantGuard` + `PermissionsGuard` + `ModuleGuard` + the boot-time route
audit, audit log.
_Exit:_ a user registers, creates a business, invites a member; `rbac.spec` and
`tenant-isolation.spec` pass.

## Phase 4 — Business domains ✅

CRM (customers, tags, notes, timeline, segments), catalog (categories, products,
variants, modifier groups), services, branches, employees, cart, checkout with
server-side pricing, orders + status pipeline, booking engine, loyalty ledger, promo
codes, inventory ledger, analytics.
_Exit:_ the three acceptance tests in `docs/guides/testing.md` pass end-to-end.

## Phase 5 — Integrations ✅

Domain-event outbox + dispatcher + worker, notification engine with templates, Telegram
multi-bot gateway + Mini App auth + bot flows, payment adapters with idempotent webhooks,
generic integration framework.
_Exit:_ `payment-idempotency.spec` and `booking-collision.spec` pass; bot connects and
serves a menu in polling mode without a public URL.

## Phase 6 — Surfaces ✅

`packages/ui` design system; admin dashboard (auth, onboarding, CRM, catalog, orders,
bookings, analytics, settings, Telegram, integrations); Mini App (commerce + booking);
public website; super admin.
_Exit:_ a business can be run end-to-end from the browser.

## Phase 7 — Hardening (next)

PostgreSQL RLS, rate limiting everywhere, outbound webhooks, real-time order/booking
updates, global search + command palette, dark mode, PWA manifest, S3 uploads with image
pipeline, observability (OpenTelemetry, Sentry), load test of the booking hot path.

## Phase 8 — Growth (after)

Marketing/campaigns, referrals, segments UI, AI assistant over the existing tool-shaped
services, automation builder, POS beta, tenant public API + webhooks, white label.

## Definition of done (every module)

Saves real data · server validates · authorization enforced · tenant isolation enforced ·
error, empty and loading states handled · usable on mobile · reusable components · no
`any` · the module's invariant tests exist and pass.
