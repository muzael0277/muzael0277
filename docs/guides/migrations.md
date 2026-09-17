# Database migrations

Prisma owns the schema. `packages/database/prisma/schema.prisma` is the source of
truth for tables and columns; everything Prisma's schema language cannot express lives
in hand-written SQL inside a migration.

## Workflow

```bash
# 1. edit packages/database/prisma/schema.prisma
# 2. generate a migration and apply it to your local database
pnpm db:migrate

# 3. commit both the schema change and the generated SQL
```

`pnpm db:migrate` runs `prisma migrate dev`: it diffs the schema against the migration
history, writes a new folder under `prisma/migrations/`, applies it, and regenerates
the client. Name it after what it does — `add_order_scheduled_for`, not `update`.

In every other environment, including CI:

```bash
pnpm db:migrate:deploy   # prisma migrate deploy — applies pending migrations, creates none
```

`deploy` never generates, never resets, and never prompts. It is the only migration
command that should ever run against data you care about.

## Rules

**Never edit a migration that has been applied anywhere else.** Prisma records a
checksum; an edited file makes every other environment refuse to migrate. Write a new
migration that corrects the old one.

**Never use `db push` against a database with data.** It rewrites the schema to match
and will silently drop a column it thinks is gone. It is for throwaway experiments
only — that is why the script is `db:push` and not part of any documented workflow.

**A schema change without a migration is a deploy-time failure.** CI catches this with
`prisma migrate diff --exit-code`, which compares the live schema to the datamodel and
fails if they have drifted apart.

## Hand-written SQL

Four things in this schema are not expressible in Prisma and are written by hand in
`20260916202500_hardening/migration.sql`. If you regenerate or squash migrations, these
must survive.

**The booking exclusion constraint (invariant I3).** A GiST `EXCLUDE` over
`(tenantId, resourceId, tsrange(blockStartsAt, blockEndsAt))`, skipping cancelled and
no-show rows. The application already serializes writers on a `ResourceDayLock` row;
this is the constraint that holds even if a future code path forgets to.

It uses `tsrange`, not `tstzrange`: Prisma maps `DateTime` to `timestamp without time
zone`, and `tstzrange` over such a column is not immutable, so the index cannot be
built. All timestamps are stored in UTC, so the comparison is still correct.

It also assumes capacity = 1. Group classes or shared tables need a counting check
instead — read `docs/architecture/09-booking-engine.md` before dropping it.

**Check constraints.** `order_total_is_consistent` and
`loyalty_amount_sign_matches_type` keep the arithmetic honest at the storage layer, so
a bug in a service cannot persist an order whose total disagrees with its parts.

**Audit append-only triggers.** `AuditLog` refuses `UPDATE` unconditionally and refuses
`DELETE` unless the transaction sets `bizbot.allow_audit_purge`. Tenant deletion and
retention purges opt in explicitly, inside their own transaction:

```ts
await prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SET LOCAL bizbot.allow_audit_purge = 'on'`;
  await tx.tenant.delete({ where: { id } });
});
```

`SET LOCAL` matters — it reverts at commit, so the permission cannot leak into the next
statement on a pooled connection. Anything that cascades into `AuditLog` needs this;
forgetting it is how `pnpm db:seed` once worked exactly once per database.

**Trigram indexes.** `pg_trgm` backs customer and product search. Both extensions
(`btree_gist`, `pg_trgm`) are created by the migration, so a fresh database needs no
manual setup.

## Ids are TEXT, not uuid

Prisma stores `String @id @default(uuid())` as `TEXT`. Raw SQL that casts a parameter
to `::uuid` will therefore fail to match — this broke the booking day lock once, which
is the mechanism behind I3. Compare ids as text. Risk R18 in
`docs/architecture/13-technical-risks.md` tracks the trade-off.

## Seeding

```bash
pnpm db:seed
```

Idempotent: it replaces the three demo tenants and leaves everything else alone. It
refuses to run when `NODE_ENV=production` unless `ALLOW_PRODUCTION_SEED=yes`.

## Resetting

```bash
pnpm db:reset   # drops the database, re-applies every migration, re-seeds
```

Destructive. Local databases only.

## Verifying data

```bash
pnpm db:check
```

Runs 17 read-only queries that should each return zero rows: loyalty balances against
their ledgers, order totals against their line items, overlapping bookings,
cross-tenant references, duplicate cashback accruals, missing snapshots. It is part of
CI and it is the first thing to run against a production snapshot when something looks
wrong.

## Backups

Before any migration that drops or rewrites a column:

```bash
pg_dump "$DATABASE_URL" --format=custom --file=pre-migration-$(date +%F).dump
```

Restore into a scratch database and run `pnpm db:check` against it to confirm the dump
is usable. A backup nobody has restored is a hypothesis, not a backup.
