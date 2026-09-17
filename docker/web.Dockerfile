# syntax=docker/dockerfile:1
#
# Shared by the three Next.js apps. APP selects which one:
#   docker build -f docker/web.Dockerfile --build-arg APP=admin .

FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
ARG APP=admin
ARG NEXT_PUBLIC_API_URL=http://localhost:4000/v1
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY . .
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile \
 && pnpm --filter @bizbot/shared build \
 && pnpm --filter @bizbot/rbac   build \
 && pnpm --filter @bizbot/i18n   build \
 && pnpm --filter "@bizbot/$APP" build

FROM base AS runtime
ARG APP=admin
ENV NODE_ENV=production
RUN useradd --create-home --shell /bin/bash bizbot
WORKDIR /app
COPY --from=build --chown=bizbot:bizbot /app ./
USER bizbot
EXPOSE 3000
CMD ["sh", "-c", "pnpm --filter @bizbot/${APP} start"]
