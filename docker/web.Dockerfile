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
# The `...` suffix builds the app's workspace dependencies first, whatever they are.
# Listing them by hand drifted: the admin started importing @bizbot/contracts and the
# image build failed on a package the list had never been updated to include.
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile \
 && pnpm --filter "@bizbot/$APP..." build

FROM base AS runtime
ARG APP=admin
ENV NODE_ENV=production
RUN useradd --create-home --shell /bin/bash bizbot
WORKDIR /app
COPY --from=build --chown=bizbot:bizbot /app ./

# Start Next directly rather than through pnpm. Corepack would try to fetch the pinned
# pnpm release on every container start — a network call at boot, in production, to run
# a command that does nothing but shell out to this same binary.
WORKDIR /app/apps/${APP}
USER bizbot
ENV PORT=3000
EXPOSE 3000
CMD ["node_modules/.bin/next", "start"]
