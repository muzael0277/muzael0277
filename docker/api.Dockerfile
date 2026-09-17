# syntax=docker/dockerfile:1
#
# API image. Multi-stage so the runtime carries no compiler, no source and no
# dev dependencies — a smaller image is also a smaller attack surface.
#
# Targets:
#   runtime   (default) — the API process, and, with a different CMD, the worker
#   migrator            — keeps dev dependencies so `prisma` and the seed script
#                         are available; used by the one-shot migrate/seed jobs

FROM node:22-slim AS base
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ── deps: cached until a manifest changes ────────────────────────────────────
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json      packages/shared/
COPY packages/rbac/package.json        packages/rbac/
COPY packages/i18n/package.json        packages/i18n/
COPY packages/config/package.json      packages/config/
COPY packages/contracts/package.json   packages/contracts/
COPY packages/database/package.json    packages/database/
COPY packages/telegram/package.json    packages/telegram/
COPY packages/payments/package.json    packages/payments/
COPY apps/api/package.json             apps/api/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ── build ────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
RUN pnpm --filter @bizbot/database generate \
 && pnpm --filter @bizbot/shared    build \
 && pnpm --filter @bizbot/rbac      build \
 && pnpm --filter @bizbot/i18n      build \
 && pnpm --filter @bizbot/config    build \
 && pnpm --filter @bizbot/contracts build \
 && pnpm --filter @bizbot/database  build \
 && pnpm --filter @bizbot/telegram  build \
 && pnpm --filter @bizbot/payments  build \
 && pnpm --filter @bizbot/api       build

# ── migrator ─────────────────────────────────────────────────────────────────
# Schema changes and the demo seed need the Prisma CLI and tsx, both dev
# dependencies. Rather than keep them in the serving image, they get their own
# image that runs to completion and exits.
FROM build AS migrator
CMD ["pnpm", "--filter", "@bizbot/database", "migrate:deploy"]

# ── prune: drop dev dependencies from what the runtime will copy ─────────────
FROM build AS pruned
RUN pnpm prune --prod

# ── runtime ──────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
# Non-root: a container escape should not start as root.
RUN useradd --create-home --shell /bin/bash bizbot
WORKDIR /app

COPY --from=pruned --chown=bizbot:bizbot /app/node_modules          ./node_modules
COPY --from=pruned --chown=bizbot:bizbot /app/packages              ./packages
COPY --from=pruned --chown=bizbot:bizbot /app/apps/api/dist         ./apps/api/dist
COPY --from=pruned --chown=bizbot:bizbot /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=pruned --chown=bizbot:bizbot /app/apps/api/package.json ./apps/api/

USER bizbot
EXPOSE 4000

# Uses the readiness endpoint, which checks the database and cache rather than
# merely proving the process is alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/readiness').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/main.js"]
