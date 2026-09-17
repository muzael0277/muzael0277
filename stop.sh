#!/usr/bin/env bash
# Stops everything. Data is kept — ./start.sh brings it all back.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
docker compose --profile full down
echo
echo "To'xtatildi. Ma'lumotlaringiz saqlanib qoldi."
echo "Qaytadan ochish uchun:  ./start.sh"
