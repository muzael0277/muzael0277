#!/usr/bin/env bash
#
# BizBot OS — one-command start for macOS and Linux.
#
#   ./start.sh
#
# Written for someone who does not program: every failure below explains what to
# do next in plain language, rather than printing a stack trace. Output is in
# Uzbek because that is who runs this.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
red()   { printf '\033[1;31m%s\033[0m\n' "$*"; }
step()  { printf '\n\033[1;36m[%s/6]\033[0m %s\n' "$1" "$2"; }

echo
green "BizBot OS ishga tushirilmoqda"
echo   "Birinchi marta 15-20 daqiqa vaqt oladi. Keyingi safar bir necha soniya."

# ── 1. Docker ────────────────────────────────────────────────────────────────
step 1 "Docker tekshirilmoqda"
if ! command -v docker >/dev/null 2>&1; then
  red "Docker topilmadi."
  echo
  echo "  Docker Desktop'ni o'rnating:  https://www.docker.com/products/docker-desktop"
  echo "  O'rnatgach, uni ishga tushiring va shu buyruqni qaytadan bering."
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  red "Docker o'rnatilgan, lekin ishlamayapti."
  echo
  echo "  Docker Desktop dasturini oching va u to'liq yuklanguncha kuting"
  echo "  (yuqoridagi kit belgisi harakatlanishdan to'xtaguncha), keyin qaytadan urinib ko'ring."
  exit 1
fi
echo "  ✓ Docker tayyor"

# ── 2. Sozlamalar ────────────────────────────────────────────────────────────
step 2 "Sozlamalar fayli"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  ✓ .env yaratildi"
else
  echo "  ✓ .env allaqachon bor"
fi

# Three secrets the app refuses to start without. Generated locally, never
# shipped, and only written when still empty so a re-run cannot rotate a live one.
fill() {
  local key="$1" value="$2"
  grep -qE "^${key}=.+" .env && return
  awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k && $2=="" {print k "=" v; next} {print}' \
    .env > .env.tmp && mv .env.tmp .env
  echo "  ✓ ${key} yaratildi"
}
fill JWT_ACCESS_SECRET      "$(openssl rand -base64 48 | tr -d '\n')"
fill JWT_REFRESH_SECRET     "$(openssl rand -base64 48 | tr -d '\n')"
fill SECRETS_ENCRYPTION_KEY "$(openssl rand -hex 32)"

# ── 3. Baza va kesh ──────────────────────────────────────────────────────────
step 3 "Ma'lumotlar bazasi ishga tushirilmoqda"
docker compose up -d postgres redis >/dev/null 2>&1 || {
  red "Baza ishga tushmadi."
  echo "  Batafsil ko'rish uchun:  docker compose logs postgres"
  exit 1
}
printf "  kutilmoqda"
for i in $(seq 1 60); do
  if docker compose exec -T postgres pg_isready -U postgres -d bizbot >/dev/null 2>&1; then
    echo; echo "  ✓ Baza tayyor"; break
  fi
  printf "."
  sleep 2
  [ "$i" -eq 60 ] && { echo; red "Baza javob bermadi."; exit 1; }
done

# ── 4. Qurish ────────────────────────────────────────────────────────────────
step 4 "Dastur qurilmoqda (eng uzoq qadam)"
echo "  Chekinmang — birinchi marta 15-20 daqiqa. Choy iching."
if ! docker compose --profile full build; then
  red "Qurish muvaffaqiyatsiz tugadi."
  echo
  echo "  Eng ko'p uchraydigan sabab — internet uzilishi. Qaytadan urinib ko'ring."
  echo "  Takrorlansa, yuqoridagi oxirgi qizil qatorni menga yuboring."
  exit 1
fi

# ── 5. Jadvallar va namuna ma'lumot ──────────────────────────────────────────
step 5 "Jadvallar yaratilmoqda va namuna bizneslar yuklanmoqda"
docker compose --profile migrate run --rm migrate >/dev/null || {
  red "Jadvallarni yaratib bo'lmadi."
  echo "  Ko'rish uchun:  docker compose --profile migrate run --rm migrate"
  exit 1
}
docker compose --profile seed run --rm seed >/dev/null 2>&1
echo "  ✓ Anor Cafe, Barber House va Zebo Beauty tayyor"

# ── 6. Ishga tushirish ───────────────────────────────────────────────────────
step 6 "Xizmatlar ishga tushirilmoqda"
docker compose --profile full up -d >/dev/null || {
  red "Ishga tushmadi."
  echo "  Ko'rish uchun:  docker compose --profile full logs"
  exit 1
}

printf "  tayyorlanmoqda"
ready=""
for i in $(seq 1 45); do
  if curl -fsS http://localhost:4000/readiness >/dev/null 2>&1; then ready=1; echo; break; fi
  printf "."
  sleep 2
done
[ -n "$ready" ] || { echo; red "Dastur javob bermadi. Ko'rish uchun: docker compose logs api"; exit 1; }

cat <<'DONE'

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Tayyor. Brauzerda oching:

    Admin panel      http://localhost:3001
    Sayt             http://localhost:3000
    Mijoz ilovasi    http://localhost:3002

  Demo hisoblar — parol hammasida:  BizBotDemo2026

    anor@bizbot.uz      Anor Cafe      restoran, yetkazib berish
    barber@bizbot.uz    Barber House   sartaroshxona, onlayn navbat
    zebo@bizbot.uz      Zebo Beauty    go'zallik saloni

  Botni ulash:
    1. Telegram'da @BotFather'ga /newbot yozing
    2. Berilgan tokenni nusxalang
    3. Admin panel → Telegram → tokenni qo'ying

  To'xtatish:      ./stop.sh
  Qayta ochish:    ./start.sh   (endi bir necha soniya)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DONE
