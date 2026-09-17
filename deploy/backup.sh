#!/usr/bin/env bash
#
# Database backup, kept for 14 days.
#
#   bash deploy/backup.sh
#
# A backup nobody has restored is a hypothesis. To check one:
#   createdb restore_test && pg_restore -d restore_test <file>
#   then run the integrity check against it.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ENV_FILE=deploy/.env.production
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

DIR=${BACKUP_DIR:-/var/backups/bizbot}
mkdir -p "$DIR"
FILE="$DIR/bizbot-$(date +%F-%H%M).dump"

docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml --env-file "$ENV_FILE" \
  exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom > "$FILE"

# An empty file means the dump failed and the shell still created the target.
[ -s "$FILE" ] || { echo "Backup is empty — dump failed."; rm -f "$FILE"; exit 1; }

echo "  $(du -h "$FILE" | cut -f1)  $FILE"
find "$DIR" -name 'bizbot-*.dump' -mtime +14 -delete
