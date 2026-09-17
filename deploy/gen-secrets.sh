#!/usr/bin/env bash
#
# Fills the blank secrets in deploy/.env.production. Safe to re-run: it only
# writes a key that is still empty, so it never silently rotates a live one.
#
#   bash deploy/gen-secrets.sh
set -euo pipefail

ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.env.production"

[ -f "$ENV_FILE" ] || {
  echo "deploy/.env.production not found. Copy it from .env.production.example first."
  exit 1
}

fill() {
  local key="$1" value="$2"
  if grep -qE "^${key}=.+" "$ENV_FILE"; then
    echo "  kept    ${key} (already set)"
    return
  fi
  # A generated secret can contain / and &, which sed would treat as syntax, so
  # the value is passed to awk as data rather than spliced into a pattern.
  awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k && $2=="" {print k "=" v; next} {print}' \
    "$ENV_FILE" > "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  echo "  set     ${key}"
}

fill POSTGRES_PASSWORD        "$(openssl rand -hex 24)"
fill JWT_ACCESS_SECRET        "$(openssl rand -base64 48 | tr -d '\n')"
fill JWT_REFRESH_SECRET       "$(openssl rand -base64 48 | tr -d '\n')"
fill SECRETS_ENCRYPTION_KEY   "$(openssl rand -hex 32)"

chmod 600 "$ENV_FILE"

cat <<'WARN'

  Back up SECRETS_ENCRYPTION_KEY somewhere other than the database backup.

  It decrypts every tenant's bot token and payment credentials. Lose it and
  there is no recovery: each business has to enter theirs again. A backup that
  holds both the ciphertext and the key protects against disk failure and
  nothing else.
WARN
