# Environment variables

Configuration is parsed and validated once, at boot, by `packages/config/src/env.ts`.
An invalid value fails the process immediately with a message naming the variable —
rather than surfacing at 3am as a confusing runtime error.

`.env.example` is the canonical list. This document explains what each variable means
and what happens if you get it wrong.

## Where the file lives

One `.env` at the repository root. `pnpm setup:env` links `apps/api/.env` and
`packages/database/.env` at it, because the API and the Prisma CLI each load their
nearest file.

In production there is no `.env` file: values come from the host's secret store or
orchestrator environment.

## Core

| Variable    | Default       | Notes                                                       |
| ----------- | ------------- | ----------------------------------------------------------- |
| `NODE_ENV`  | `development` | `production` turns on the extra checks described below      |
| `APP_NAME`  | `BizBot OS`   | Shown in emails and bot messages                            |
| `LOG_LEVEL` | `info`        | `fatal` … `trace`; use `debug` sparingly, the logs are wide |

## API

| Variable            | Default                 | Notes                                                  |
| ------------------- | ----------------------- | ------------------------------------------------------ |
| `API_PORT`          | `4000`                  |                                                        |
| `API_HOST`          | `0.0.0.0`               | Bind address                                           |
| `API_PUBLIC_URL`    | `http://localhost:4000` | Used in links sent to customers                        |
| `API_GLOBAL_PREFIX` | `v1`                    | `/health` and `/readiness` are deliberately outside it |

## Surfaces

`WEB_URL`, `ADMIN_URL`, `MINIAPP_URL`. These are the CORS allow-list and the base for
links in notifications. Getting one wrong shows up as a blocked cross-origin request in
the browser console, not as a server error.

## Data

| Variable             | Required | Notes                                                   |
| -------------------- | -------- | ------------------------------------------------------- |
| `DATABASE_URL`       | yes      | Postgres 14+; `?schema=public`                          |
| `DATABASE_POOL_SIZE` | no (10)  | Per process. The API and the worker each open their own |
| `REDIS_URL`          | no       | Queues, rate limiting, tenant cache                     |

## Auth and secrets

| Variable                 | Required | Generate with             |
| ------------------------ | -------- | ------------------------- |
| `JWT_ACCESS_SECRET`      | yes      | `openssl rand -base64 48` |
| `JWT_REFRESH_SECRET`     | yes      | `openssl rand -base64 48` |
| `JWT_ACCESS_TTL`         | no (15m) | —                         |
| `JWT_REFRESH_TTL_DAYS`   | no (30)  | —                         |
| `SECRETS_ENCRYPTION_KEY` | yes      | `openssl rand -hex 32`    |

Three rules the schema enforces when `NODE_ENV=production`:

1. **The two JWT secrets must differ.** If they are the same, a leaked access-token key
   also mints refresh tokens, and a stolen 15-minute credential becomes a 30-day one.
2. **No placeholder values.** Anything beginning with `dev`, `test`, `change`, `secret`,
   `password` or `example` is rejected.
3. **`RUN_WORKER_IN_API` must be false.** See below.

`SECRETS_ENCRYPTION_KEY` is the AES-256-GCM key for the integration vault: tenant bot
tokens, Click and Payme credentials. **Losing it makes every stored credential
unrecoverable** — every tenant has to re-enter theirs. Back it up separately from the
database, and rotate it only with a re-encryption pass, never by swapping the value.

## Telegram

| Variable                    | Values                             | Notes                                      |
| --------------------------- | ---------------------------------- | ------------------------------------------ |
| `TELEGRAM_MODE`             | `polling` / `webhook` / `disabled` | `polling` locally, `webhook` in production |
| `TELEGRAM_API_BASE`         | `https://api.telegram.org`         | Change only for a local Bot API server     |
| `TELEGRAM_WEBHOOK_BASE_URL` | public HTTPS origin                | Required when mode is `webhook`            |

Bot tokens are **not** environment variables. Each tenant stores its own, encrypted, in
the integration vault — see [telegram.md](telegram.md).

## Storage

| Variable             | Notes                                                          |
| -------------------- | -------------------------------------------------------------- |
| `STORAGE_DRIVER`     | `local` or `s3`                                                |
| `STORAGE_LOCAL_PATH` | Where uploads go with the local driver                         |
| `STORAGE_PUBLIC_URL` | The base URL those files are served from                       |
| `S3_*`               | Endpoint, region, bucket, key pair — any S3-compatible service |

With `STORAGE_DRIVER=s3`, the schema requires `S3_BUCKET`, `S3_ACCESS_KEY_ID` and
`S3_SECRET_ACCESS_KEY`. A half-configured S3 that silently falls back to local disk
loses uploads on the next deploy.

## Queues

| Variable             | Default  | Notes                                                  |
| -------------------- | -------- | ------------------------------------------------------ |
| `QUEUE_PREFIX`       | `bizbot` | Namespace, so several environments can share one Redis |
| `WORKER_CONCURRENCY` | `5`      | Jobs in flight per worker process                      |
| `RUN_WORKER_IN_API`  | `false`  | `true` locally; **rejected in production**             |

The worker is the same image with a different entrypoint (ADR-0001). Running it inside
the API is fine on a laptop and wrong on a server, where a long job would occupy an
event loop that is also answering HTTP.

## Behaviour flags

| Variable             | Default | Notes                                                        |
| -------------------- | ------- | ------------------------------------------------------------ |
| `ENABLE_DEMO_MODE`   | `true`  | Allows the demo tenants and the mock payment provider        |
| `ENABLE_SWAGGER`     | `true`  | Turn off in production unless the API is deliberately public |
| `RATE_LIMIT_ENABLED` | `true`  | Leave on                                                     |

## Frontend build-time

`NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_ADMIN_URL` are inlined into the client bundle at
build time, so they are **not** container hostnames — they are the URLs the browser
will use. Changing one means rebuilding the image, not restarting it.

Nothing secret ever goes in a `NEXT_PUBLIC_*` variable: everything so named is shipped
to every visitor in plain text.

## Adding a variable

Add it to the zod schema in `packages/config/src/env.ts` with a default or an explicit
`required`, document it in `.env.example`, and — if it is security-relevant — add the
production check to the `superRefine` block. A variable read straight from
`process.env` somewhere in a service bypasses all of that, and will be found missing on
the day it matters.
