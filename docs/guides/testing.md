# Testing

```bash
pnpm test                 # everything: 238 tests
pnpm lint                 # prettier --check, then tsc across the workspace
pnpm db:check             # verify stored data against the invariants
```

## What exists

| Suite                                          | Tests | Needs a database |
| ---------------------------------------------- | ----: | ---------------- |
| `packages/shared` — money, phone, time         |    28 | no               |
| `packages/rbac` — roles, permissions, modules  |    22 | no               |
| `packages/contracts` — request schemas         |    47 | no               |
| `packages/payments` — provider adapters        |    27 | no               |
| `packages/telegram` — `initData` verification  |    12 | no               |
| `packages/database` — the tenant guard         |    34 | **yes**          |
| `apps/api` — pricing, availability, invariants |    54 | **yes**          |

The database suites run against a real Postgres. There is no in-memory substitute that
would be honest here: the guarantees being tested are `FOR UPDATE` locks, exclusion
constraints and transaction boundaries, and a fake would test the fake.

Both database suites set `fileParallelism: false`. They share one database, so parallel
files would let one suite's cleanup delete another's fixtures.

## Running a subset

```bash
pnpm --filter @bizbot/api test                      # one package
pnpm --filter @bizbot/api exec vitest run -t "I3"   # one invariant
pnpm --filter @bizbot/api exec vitest                # watch mode
```

## The invariant suite

`apps/api/src/__tests__/invariants.spec.ts` is the load-bearing file. It exercises the
real services against a real database — not mocks — because that is where these
behaviours actually broke during development.

**I1 — tenant isolation.** Tenant A reading, updating, deleting or relating to tenant
B's rows. Every one must fail or return nothing. The 34 tests in
`packages/database` cover the guard itself: reads, writes, composite-unique writes,
nested creates, the `Tenant` model scoping on its own id, fail-closed behaviour when no
context is set, and the fact that **raw SQL is not covered by the guard** — every raw
query needs its own explicit tenant predicate, and there are regression tests for the
two places that once forgot.

**I2 — server-side pricing.** A checkout request claiming `price=1`, `subtotal=1`,
`total=1`, `discount=999999` is charged the full catalogue price. The contract schemas
have no field for a price or a total at all, so the claim cannot even be expressed; the
test asserts what happens when someone sends it anyway.

**I3 — no double booking.** Concurrent requests for the same slot: exactly one
succeeds, the rest get `BOOKING_SLOT_TAKEN`. Verified at the service level and over
real HTTP with 8 simultaneous requests.

**I5 — loyalty ledger.** Concurrent adjustments to one account sum correctly, because
the account row is locked `FOR UPDATE` for the duration.

**I4 — webhook replay.** Covered twice. At the adapter level in `packages/payments`:
signature verification, amount conversion, and an idempotency key per callback type.
Then through the real `PaymentsService` against a real database — a forged callback, a
Prepare, four identical Completes, a re-signed callback claiming ten times the amount,
a tampered payload, and a valid callback naming a payment that does not exist. The
result is one `PAID` payment, one order completion, at most one loyalty accrual, and no
500 for the provider to retry against forever.

**I7 — secret confidentiality.** A Payme merchant key is configured through the real
integration service, then looked for everywhere it could leak: the upsert response, the
integrations list the admin UI renders, the stored row itself, and tenant B's view. It
is also checked that editing the public config does not wipe credentials that were not
retyped — a "safe" failure that silently disconnects payments.

## Pure logic tests

Pricing (`apps/api/src/modules/cart/pricing.service.ts`) and availability
(`apps/api/src/modules/bookings/availability.engine.ts`) are pure functions with no
Prisma import, which is why they can be tested exhaustively and quickly. Between them
they hold most of the rules a business actually cares about: discount ordering, the
delivery-fee threshold judged after discounts, largest-remainder distribution so line
discounts sum back to the order discount, buffer handling around appointments, and grid
anchoring so slots land on clean times.

Several of those tests exist because they failed first — a slot whose cleanup buffer
ran past the end of a shift was offered to customers until a test said so.

## Data integrity

`pnpm db:check` is different in kind from the suites above. Instead of asking "does
this function behave", it asks **"given whatever is stored right now, does any of it
violate an invariant"** — 17 read-only queries that should each return zero rows:

- loyalty balances against their ledgers, and amount signs against their types
- order totals against their components, and subtotals against their line items
- line discounts summing back to the order discount
- overlapping live bookings on one resource
- cross-tenant references between orders, items, customers, bookings and loyalty rows
- duplicate cashback accruals on one order
- missing product-name snapshots, duplicate order numbers

It runs in CI against the seeded demo data, and it is the first thing to run against a
production snapshot when something looks wrong. It found two real bugs the unit tests
could not see: a seed that put the whole order discount on the header while leaving
every line at full price, and a seed that could not run twice against the same
database.

## Browser check

```bash
pnpm e2e:admin
```

`tools/e2e-admin.mjs` drives the admin dashboard in a real Chromium: sign in as Anor
Cafe, load products, orders and customers, toggle a module, confirm the navigation is
derived from enabled modules (Bookings is correctly absent for a restaurant), press
Escape to close a dialog, and assert no console errors and no failed API calls.

It waits on the _data_, not on fixed delays — an earlier version measured while
skeleton rows were still showing and cheerfully reported a working page full of `—`.

## CI

`.github/workflows/ci.yml` runs three jobs:

1. **static** — formatting, Prisma schema validation, a full build, then typecheck
   against the real emitted declarations.
2. **test** — migrations via `migrate deploy` (so the migration files themselves are
   exercised), a drift check that fails if `schema.prisma` was edited without a
   migration, the full suite against real Postgres and Redis, the demo seed **twice**,
   and `db:check`.
3. **docker** — builds the API and admin images.

The CI secrets are in the workflow file in plain sight because they protect nothing:
the database is discarded with the runner. Real secrets live in the host's secret store
and never in a repository.

## Writing a test here

Two things are worth insisting on.

**Test the behaviour, not the implementation.** The invariant tests call the real
services. When the booking lock was rewritten, they kept passing, which is the point.

**When you fix a bug, write the failing test first.** Every entry in the list above
that reads like an oddity — Prepare is not Complete, tiyin is not so'm, the cleanup
buffer runs past the shift, a stray callback must not be answered with a 500 — is there
because something shipped wrong once.

## Not covered yet

No load testing, no visual regression testing, and no automated accessibility audit.
The Mini App has no browser-level end-to-end test — its flows are covered at the API
level only. These are known gaps, not oversights.
