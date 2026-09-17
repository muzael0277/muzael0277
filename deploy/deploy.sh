#!/usr/bin/env bash
#
# Builds, migrates and restarts. Run it for the first deploy and every one after:
#
#   bash deploy/deploy.sh
#
# Order matters: back up, migrate, then swap the code. Migrations run against
# the *old* code still serving traffic, which is why they have to be backwards
# compatible — see docs/guides/migrations.md.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ENV_FILE=deploy/.env.production
COMPOSE="docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml --env-file $ENV_FILE --profile full"

[ -f "$ENV_FILE" ] || { echo "$ENV_FILE not found."; exit 1; }
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }

for key in JWT_ACCESS_SECRET JWT_REFRESH_SECRET SECRETS_ENCRYPTION_KEY POSTGRES_PASSWORD; do
  [ -n "${!key:-}" ] || { echo "$key is empty. Run: bash deploy/gen-secrets.sh"; exit 1; }
done

if docker volume ls -q | grep -q '^bizbot_postgres-data$'; then
  log "Backing up the database first"
  bash deploy/backup.sh
fi

log "Building images"
# NEXT_PUBLIC_API_URL is inlined into the browser bundle, so the frontends have
# to be rebuilt — not merely restarted — whenever it changes.
$COMPOSE build

log "Applying migrations"
$COMPOSE run --rm migrate

log "Starting services"
$COMPOSE up -d --remove-orphans

log "Waiting for the API to report ready"
for i in $(seq 1 30); do
  if $COMPOSE exec -T api node -e "fetch('http://127.0.0.1:4000/readiness').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "  ready after ${i}0s"
    break
  fi
  [ "$i" -eq 30 ] && { echo "  API never became ready:"; $COMPOSE logs --tail=50 api; exit 1; }
  sleep 10
done

log "Verifying stored data against the invariants"
$COMPOSE run --rm --entrypoint sh migrate -c "pnpm --filter @bizbot/database check:integrity"

log "Removing images no longer referenced"
docker image prune -f >/dev/null

$COMPOSE ps
log "Deployed"
