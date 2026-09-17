# Deployment

The system deploys as four images built from one repository: the **API**, the
**worker** (the API image with a different entrypoint), and the three **Next.js**
apps. Postgres and Redis are the only external dependencies.

## Building

```bash
docker build -f docker/api.Dockerfile --target runtime -t bizbot-api:$(git rev-parse --short HEAD) .
docker build -f docker/web.Dockerfile --build-arg APP=admin   --build-arg NEXT_PUBLIC_API_URL=https://api.example.uz/v1 -t bizbot-admin:$TAG .
docker build -f docker/web.Dockerfile --build-arg APP=miniapp --build-arg NEXT_PUBLIC_API_URL=https://api.example.uz/v1 -t bizbot-miniapp:$TAG .
docker build -f docker/web.Dockerfile --build-arg APP=web     --build-arg NEXT_PUBLIC_API_URL=https://api.example.uz/v1 -t bizbot-web:$TAG .
```

`NEXT_PUBLIC_API_URL` is **baked in at build time** — Next inlines it into the client
bundle. It is the URL the browser will call, not an internal hostname, and changing it
means rebuilding the image rather than restarting it.

The API image has three useful targets:

| Target     | Contains                                   | Used for                       |
| ---------- | ------------------------------------------ | ------------------------------ |
| `runtime`  | Compiled output, production deps, non-root | Serving the API and the worker |
| `migrator` | Everything plus the Prisma CLI and tsx     | Migrations and the seed        |
| `build`    | Full toolchain                             | Intermediate                   |

The runtime image runs as the unprivileged `bizbot` user and carries no compiler and no
source. The migrator exists because `prisma` and `tsx` are dev dependencies, pruned
from the runtime image — a serving image that can rewrite the schema is a serving image
that can rewrite the schema by accident.

## Running the worker

Same image, different command:

```bash
docker run bizbot-api:$TAG node apps/api/dist/main.worker.js
```

One codebase, one dependency tree, one DI container, no HTTP listener. Two separately
built images would drift apart, which is exactly what
[ADR-0001](../adr/0001-modular-monolith.md) avoids.

`RUN_WORKER_IN_API` must be `false` in production — the config schema refuses anything
else. A long job inside the API process occupies an event loop that is also answering
requests.

## Secrets

Never in the image, never in the repository, never in a compose file.

| Secret                   | Consequence of loss                                        |
| ------------------------ | ---------------------------------------------------------- |
| `JWT_ACCESS_SECRET`      | Rotating it logs everyone out — acceptable                 |
| `JWT_REFRESH_SECRET`     | Same, plus refresh tokens are invalidated                  |
| `SECRETS_ENCRYPTION_KEY` | **Every stored integration credential becomes unreadable** |

The encryption key is the one that cannot be regenerated. Back it up separately from
the database — a backup that contains both the ciphertext and the key protects nothing
— and rotate it only with a re-encryption pass over the `SecretVault` rows, never by
swapping the value.

The two JWT secrets must differ, and the config schema enforces it in production, along
with rejecting anything that looks like a placeholder.

## Deploy sequence

```bash
# 1. back up
pg_dump "$DATABASE_URL" --format=custom --file=pre-deploy-$(date +%F-%H%M).dump

# 2. migrate, using the migrator image
docker run --rm --env-file /run/secrets/bizbot.env bizbot-migrator:$TAG \
  pnpm --filter @bizbot/database migrate:deploy

# 3. roll the API and worker
# 4. roll the frontends
```

Migrations run before the new code, so write them to be **backwards compatible with the
currently running version**. A column the old code still writes cannot be dropped in
the same deploy: add, backfill, ship the code that stops using it, drop in the next
deploy. Details in [migrations.md](migrations.md).

## Health checks

| Endpoint     | Answers                                 | Use for                   |
| ------------ | --------------------------------------- | ------------------------- |
| `/health`    | Is the process alive                    | Liveness probe / restarts |
| `/readiness` | Can it reach the database and the cache | Readiness probe / LB pool |

Neither is under `/v1`. Point liveness at `/health` and readiness at `/readiness` — a
container that restarts because Postgres blinked turns a brief database problem into an
outage.

The API image's built-in `HEALTHCHECK` calls `/readiness`. The worker image sets
`HEALTHCHECK NONE`: it has no HTTP listener, and inheriting the API's check would mark
a perfectly healthy worker unhealthy.

## Reverse proxy

Terminate TLS at the proxy and route by hostname:

| Hostname           | Upstream      |
| ------------------ | ------------- |
| `example.uz`       | web :3000     |
| `admin.example.uz` | admin :3000   |
| `app.example.uz`   | miniapp :3000 |
| `api.example.uz`   | api :4000     |

Three things the proxy must get right:

**Do not buffer or rewrite webhook bodies.** Click and Payme signatures are computed
over the raw bytes; a proxy that reserializes JSON breaks every callback.

**Forward the real client IP** (`X-Forwarded-For`), or rate limiting sees one client.

**Allow the Mini App to be framed by Telegram.** A blanket `X-Frame-Options: DENY`
leaves customers with a blank window.

Telegram requires a valid certificate for webhooks. A self-signed one is rejected
silently, which presents as "the bot does nothing".

## Local full stack

```bash
docker compose --profile full up --build
```

Brings up Postgres, Redis, migrations, the API, the worker and all three frontends.
Without a profile, `docker compose up -d` starts only Postgres and Redis, which is what
you want while developing with `pnpm dev`.

The three secrets have no compose default: `docker compose` fails with a message naming
the missing variable rather than booting with a placeholder signing key.

```bash
docker compose --profile seed up seed    # load the demo tenants
```

## After deploying

```bash
pnpm db:check
```

17 read-only queries against the invariants. It is fast, it touches nothing, and it
turns "something feels wrong" into a specific violated rule.

Watch, in order of how much they matter:

- `/readiness` on the API
- queue depth in Redis — a growing backlog means the worker is down or too slow
- the `DomainEvent` table for undispatched rows
- Telegram webhook failures, which Telegram reports via `getWebhookInfo`

## Rollback

The API image is stateless: redeploy the previous tag. Migrations are the exception —
Prisma does not generate down-migrations, so a schema change that must be undone needs
a new forward migration. This is the reason for the backwards-compatibility rule above:
if the old code still runs against the new schema, rollback is just a tag change.

## Not built yet

No Terraform or Helm charts, no blue-green or canary orchestration, no automated
backup scheduling, and no centralized log aggregation — the API emits structured JSON
on stdout, ready to ship somewhere, but nothing ships it. These are deliberate gaps for
the MVP, not oversights.
