# Local development

## Prerequisites

| Tool   | Version | Why that version                                                          |
| ------ | ------- | ------------------------------------------------------------------------- |
| Node   | 22      | `--env-file-if-exists`, and the Prisma 6 engines are built against it     |
| pnpm   | 10      | Workspace protocol and the lockfile format; `corepack enable` installs it |
| Docker | any     | Postgres 16 and Redis 7; nothing else in the stack needs it locally       |

Postgres must be 14 or newer: the booking exclusion constraint uses a `tsrange` GiST
index, and `pg_trgm` backs search.

## First run

```bash
pnpm install
docker compose up -d postgres redis
pnpm setup:env
```

`pnpm setup:env` copies `.env.example` to `.env` and symlinks `apps/api/.env` and
`packages/database/.env` at it. Both the API and the Prisma CLI load their _nearest_
`.env`, so without the links you end up maintaining three copies of the same secrets —
and rotating one of them in two places out of three.

Open `.env` and fill in the three blank values:

```bash
openssl rand -base64 48   # JWT_ACCESS_SECRET
openssl rand -base64 48   # JWT_REFRESH_SECRET
openssl rand -hex 32      # SECRETS_ENCRYPTION_KEY
```

They are blank rather than pre-filled on purpose. A placeholder that works locally is a
placeholder that reaches production; `packages/config` rejects anything starting with
`dev`, `test`, `change`, `secret`, `password` or `example` when `NODE_ENV=production`,
and it rejects two identical JWT secrets outright.

Then set up the database:

```bash
pnpm db:migrate:deploy   # apply the migration history
pnpm db:seed             # three demo businesses with real history
```

## Running

```bash
pnpm dev
```

| App     | URL                   | Notes                                                           |
| ------- | --------------------- | --------------------------------------------------------------- |
| api     | http://localhost:4000 | Routes under `/v1`; `/health` and `/readiness` are not prefixed |
| web     | http://localhost:3000 | Public site                                                     |
| admin   | http://localhost:3001 | Business dashboard                                              |
| miniapp | http://localhost:3002 | Telegram Mini App; opens in a browser too                       |

To run one app on its own: `pnpm --filter @bizbot/api dev`.

The worker runs inside the API process locally because `RUN_WORKER_IN_API=true` in
`.env.example`. That is convenient and it is refused in production, where a slow job
must not be able to stall HTTP. To run it separately:

```bash
pnpm --filter @bizbot/api dev:worker
```

## Demo accounts

Password for all three: `BizBotDemo2026`.

| Login              | Business     | Template   | Interesting because                        |
| ------------------ | ------------ | ---------- | ------------------------------------------ |
| `anor@bizbot.uz`   | Anor Cafe    | RESTAURANT | Delivery, menu modifiers, 28 orders        |
| `barber@bizbot.uz` | Barber House | SERVICE    | 3 masters, shifts, booking history         |
| `zebo@bizbot.uz`   | Zebo Beauty  | BEAUTY     | 4 masters plus a room as a second resource |

Demo tenants are flagged `isDemo` and excluded from platform analytics and billing.
They use the mock payment provider and the bot runs in polling mode, so no Telegram
token and no Click/Payme credentials are needed to click through the whole product.

`pnpm db:seed` is safe to re-run: it replaces the three demo tenants and leaves any
tenant you created yourself alone.

## Everyday commands

```bash
pnpm build                # everything, in dependency order
pnpm test                 # 224 tests
pnpm lint                 # prettier --check, then tsc across the workspace
pnpm format               # fix formatting
pnpm db:check             # verify stored data against the invariants
pnpm --filter @bizbot/database studio    # Prisma Studio
```

## Things that will bite you

**The API starts and every injected dependency is `undefined`.** NestJS reads
constructor types from the `design:paramtypes` metadata that only `tsc` and SWC emit —
esbuild does not. The API therefore builds with `nest build` (tsc) and tests with
`unplugin-swc`, not with `tsx`. If you are tempted to swap in a faster transformer,
this is why you cannot.

**`tsc` emits nothing after you delete `dist/`.** The stale `tsconfig.tsbuildinfo`
still claims everything is up to date. `apps/api` sets `"incremental": false` for this
reason; elsewhere, `pnpm --filter <pkg> clean` removes both.

**Types from `@prisma/client` are missing or stale.** Run `pnpm db:generate`. Anything
importing the generated client needs it regenerated after a schema change.

**`Module not found: node:crypto` in a Next build.** You imported from
`@bizbot/shared` something that lives in `@bizbot/shared/server`. The package has two
entry points precisely so browser bundles never pull Node built-ins.

**The boot fails with "route authorization audit".** A controller method has no
`@Public`, `@RequirePermission`, `@CustomerRoute`, `@RequirePlatformRole` or
`@AuthenticatedRoute`. The API refuses to start rather than serve an unguarded route;
add the annotation the route actually needs — do not reach for `@Public` to make it
go away.

**Tests fail with "record not found" printed by Prisma.** That is expected output, not
a failure. The tenant-isolation tests assert that a cross-tenant read finds nothing,
and Prisma logs the miss. Read the summary line at the bottom.

## Editing the database schema

See **[migrations.md](migrations.md)**. Short version: edit
`packages/database/prisma/schema.prisma`, run `pnpm db:migrate`, commit the generated
SQL. Never hand-edit a migration that has already been applied anywhere else.
