@echo off
REM Stops everything. Data is kept - start.cmd brings it all back.
cd /d "%~dp0"
docker compose --profile full down
echo.
echo To'xtatildi. Ma'lumotlaringiz saqlanib qoldi.
echo Qaytadan ochish uchun:  start.cmd
echo.
pause
