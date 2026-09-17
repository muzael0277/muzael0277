#!/usr/bin/env bash
#
# Prepares a fresh Ubuntu 24.04 VPS to run BizBot OS. Run once, as root:
#
#   bash deploy/setup-server.sh
#
# Installs Docker, opens only the ports that must be open, and adds swap so a
# build does not get the process killed on a small machine.
set -euo pipefail

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Run as root."; exit 1; }

log "Updating packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git ufw fail2ban

log "Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
docker --version

# A 4 GB machine runs the system comfortably but can run out of memory during a
# Next.js build, which presents as a build that dies with no error at all.
if [ ! -f /swapfile ] && [ "$(free -m | awk '/^Mem:/{print $2}')" -lt 6000 ]; then
  log "Adding 2 GB swap"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "Configuring the firewall"
# Only SSH and the web. Postgres and Redis are not published at all in the
# production compose overlay, but a firewall is the second lock on that door.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status verbose

log "Enabling fail2ban for SSH"
systemctl enable --now fail2ban

log "Done"
cat <<'NEXT'

Next:
  1. Point four A records at this server's IP:
       example.uz  admin.example.uz  app.example.uz  api.example.uz
     Wait until `dig +short api.example.uz` returns the IP before continuing —
     Let's Encrypt validates over HTTP and fails on a domain that does not
     resolve yet.

  2. git clone <your repo> /opt/bizbot && cd /opt/bizbot
  3. cp deploy/.env.production.example deploy/.env.production
     $EDITOR deploy/.env.production      # set the four domains and the email
     bash deploy/gen-secrets.sh          # fills the blank secrets
  4. bash deploy/init-letsencrypt.sh     # certificates, once
  5. bash deploy/deploy.sh               # build, migrate, start
NEXT
