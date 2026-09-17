@echo off
REM BizBot OS - one-command start for Windows.
REM Double-click this file, or run `start.cmd` in a terminal.
REM
REM Written for someone who does not program: every failure explains what to do
REM next in plain language.
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo   BizBot OS ishga tushirilmoqda
echo   Birinchi marta 15-20 daqiqa vaqt oladi. Keyingi safar bir necha soniya.
echo.

REM --- 1. Docker ------------------------------------------------------------
echo [1/6] Docker tekshirilmoqda
where docker >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Docker topilmadi.
  echo.
  echo   Docker Desktop'ni o'rnating:  https://www.docker.com/products/docker-desktop
  echo   O'rnatgach, uni ishga tushiring va bu faylni qaytadan oching.
  echo.
  pause
  exit /b 1
)
docker info >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Docker o'rnatilgan, lekin ishlamayapti.
  echo.
  echo   Docker Desktop dasturini oching va u to'liq yuklanguncha kuting,
  echo   keyin bu faylni qaytadan oching.
  echo.
  pause
  exit /b 1
)
echo   OK - Docker tayyor

REM --- 2. Sozlamalar --------------------------------------------------------
echo.
echo [2/6] Sozlamalar fayli
if not exist .env (
  copy .env.example .env >nul
  echo   OK - .env yaratildi
) else (
  echo   OK - .env allaqachon bor
)

REM The app refuses to start without these three. Generated inside a container
REM so Windows needs no openssl of its own.
docker run --rm node:22-slim node -e "const c=require('node:crypto');console.log(c.randomBytes(48).toString('base64'));console.log(c.randomBytes(48).toString('base64'));console.log(c.randomBytes(32).toString('hex'))" > .secrets.tmp 2>nul
set /a n=0
for /f "usebackq delims=" %%s in (".secrets.tmp") do (
  set /a n+=1
  if !n!==1 set ACCESS=%%s
  if !n!==2 set REFRESH=%%s
  if !n!==3 set ENCKEY=%%s
)
del .secrets.tmp >nul 2>&1

powershell -NoProfile -Command ^
  "$p='.env'; $t=Get-Content $p -Raw;" ^
  "if ($t -match '(?m)^JWT_ACCESS_SECRET=\s*$')      { $t = $t -replace '(?m)^JWT_ACCESS_SECRET=\s*$',      'JWT_ACCESS_SECRET=%ACCESS%' }" ^
  "if ($t -match '(?m)^JWT_REFRESH_SECRET=\s*$')     { $t = $t -replace '(?m)^JWT_REFRESH_SECRET=\s*$',     'JWT_REFRESH_SECRET=%REFRESH%' }" ^
  "if ($t -match '(?m)^SECRETS_ENCRYPTION_KEY=\s*$') { $t = $t -replace '(?m)^SECRETS_ENCRYPTION_KEY=\s*$', 'SECRETS_ENCRYPTION_KEY=%ENCKEY%' }" ^
  "Set-Content $p $t -NoNewline"
echo   OK - maxfiy kalitlar tayyor

REM --- 3. Baza --------------------------------------------------------------
echo.
echo [3/6] Ma'lumotlar bazasi ishga tushirilmoqda
docker compose up -d postgres redis >nul 2>&1
if errorlevel 1 (
  echo   Baza ishga tushmadi. Ko'rish uchun:  docker compose logs postgres
  pause
  exit /b 1
)
echo   kutilmoqda...
for /l %%i in (1,1,60) do (
  docker compose exec -T postgres pg_isready -U postgres -d bizbot >nul 2>&1
  if not errorlevel 1 goto dbready
  timeout /t 2 /nobreak >nul
)
echo   Baza javob bermadi.
pause
exit /b 1
:dbready
echo   OK - Baza tayyor

REM --- 4. Qurish ------------------------------------------------------------
echo.
echo [4/6] Dastur qurilmoqda (eng uzoq qadam)
echo   Chekinmang - birinchi marta 15-20 daqiqa. Choy iching.
docker compose --profile full build
if errorlevel 1 (
  echo.
  echo   Qurish muvaffaqiyatsiz tugadi. Eng ko'p uchraydigan sabab - internet uzilishi.
  echo   Qaytadan urinib ko'ring. Takrorlansa, oxirgi xato qatorini menga yuboring.
  pause
  exit /b 1
)

REM --- 5. Jadvallar ---------------------------------------------------------
echo.
echo [5/6] Jadvallar yaratilmoqda va namuna bizneslar yuklanmoqda
docker compose --profile migrate run --rm migrate >nul
if errorlevel 1 (
  echo   Jadvallarni yaratib bo'lmadi.
  echo   Ko'rish uchun:  docker compose --profile migrate run --rm migrate
  pause
  exit /b 1
)
docker compose --profile seed run --rm seed >nul 2>&1
echo   OK - Anor Cafe, Barber House va Zebo Beauty tayyor

REM --- 6. Ishga tushirish ---------------------------------------------------
echo.
echo [6/6] Xizmatlar ishga tushirilmoqda
docker compose --profile full up -d >nul
if errorlevel 1 (
  echo   Ishga tushmadi. Ko'rish uchun:  docker compose --profile full logs
  pause
  exit /b 1
)
echo   tayyorlanmoqda...
timeout /t 20 /nobreak >nul

echo.
echo ===============================================================
echo.
echo   Tayyor. Brauzerda oching:
echo.
echo     Admin panel      http://localhost:3001
echo     Sayt             http://localhost:3000
echo     Mijoz ilovasi    http://localhost:3002
echo.
echo   Demo hisoblar - parol hammasida:  BizBotDemo2026
echo.
echo     anor@bizbot.uz      Anor Cafe      restoran, yetkazib berish
echo     barber@bizbot.uz    Barber House   sartaroshxona, onlayn navbat
echo     zebo@bizbot.uz      Zebo Beauty    go'zallik saloni
echo.
echo   Botni ulash:
echo     1. Telegram'da @BotFather'ga /newbot yozing
echo     2. Berilgan tokenni nusxalang
echo     3. Admin panel -^> Telegram -^> tokenni qo'ying
echo.
echo   To'xtatish:      stop.cmd
echo   Qayta ochish:    start.cmd   (endi bir necha soniya)
echo.
echo ===============================================================
echo.
start http://localhost:3001
pause
