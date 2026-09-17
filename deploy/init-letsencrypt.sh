#!/usr/bin/env bash
#
# Issues the TLS certificates. Run once, after DNS points at this server:
#
#   bash deploy/init-letsencrypt.sh
#
# The chicken-and-egg problem: nginx will not start without a certificate, and
# certbot cannot validate without nginx answering on port 80. So a throwaway
# self-signed certificate goes in first, nginx starts on it, certbot replaces it
# with the real one, and nginx reloads.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ENV_FILE=deploy/.env.production
COMPOSE="docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml --env-file $ENV_FILE --profile full"

[ -f "$ENV_FILE" ] || { echo "$ENV_FILE not found. See deploy/.env.production.example"; exit 1; }
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

DOMAINS=("$DOMAIN" "www.$DOMAIN" "$ADMIN_DOMAIN" "$MINIAPP_DOMAIN" "$API_DOMAIN")
: "${CERTBOT_EMAIL:?set CERTBOT_EMAIL in $ENV_FILE}"

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }

log "Checking DNS"
MYIP=$(curl -fsS https://api.ipify.org || true)
for d in "${DOMAINS[@]}"; do
  got=$(getent hosts "$d" | awk '{print $1}' | head -1 || true)
  if [ -z "$got" ]; then
    echo "  ✗ $d does not resolve yet — certbot will fail. Add the A record and wait."
    exit 1
  fi
  [ -n "$MYIP" ] && [ "$got" != "$MYIP" ] && echo "  ! $d resolves to $got, not $MYIP" || echo "  ✓ $d"
done

log "Planting a temporary self-signed certificate so nginx can start"
# One per certificate name, because the nginx config references each by name.
for d in "$DOMAIN" "$ADMIN_DOMAIN" "$MINIAPP_DOMAIN" "$API_DOMAIN"; do
  $COMPOSE run --rm --entrypoint sh certbot -c "
    mkdir -p /etc/letsencrypt/live/$d
    openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
      -keyout /etc/letsencrypt/live/$d/privkey.pem \
      -out /etc/letsencrypt/live/$d/fullchain.pem -subj '/CN=$d' 2>/dev/null
  "
done

log "Fetching certbot's recommended TLS settings"
$COMPOSE run --rm --entrypoint sh certbot -c "
  [ -f /etc/letsencrypt/options-ssl-nginx.conf ] || curl -fsS -o /etc/letsencrypt/options-ssl-nginx.conf \
    https://raw.githubusercontent.com/certbot/certbot/main/certbot-nginx/certbot_nginx/_internal/tls_configs/options-ssl-nginx.conf
  [ -f /etc/letsencrypt/ssl-dhparams.pem ] || curl -fsS -o /etc/letsencrypt/ssl-dhparams.pem \
    https://raw.githubusercontent.com/certbot/certbot/main/certbot/certbot/ssl-dhparams.pem
"

log "Starting nginx"
$COMPOSE up -d nginx
sleep 5

log "Requesting the real certificates"
for d in "$DOMAIN" "$ADMIN_DOMAIN" "$MINIAPP_DOMAIN" "$API_DOMAIN"; do
  extra=""
  [ "$d" = "$DOMAIN" ] && extra="-d www.$DOMAIN"
  # --force-renewal replaces the self-signed placeholder, which certbot would
  # otherwise consider a perfectly good existing certificate.
  $COMPOSE run --rm certbot certonly --webroot -w /var/www/certbot \
    --email "$CERTBOT_EMAIL" --agree-tos --no-eff-email \
    --force-renewal -d "$d" $extra
done

log "Reloading nginx onto the real certificates"
$COMPOSE exec nginx nginx -s reload

log "Done — https://$ADMIN_DOMAIN should now have a valid certificate"
