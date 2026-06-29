@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Starting Claude / Codex usage dashboard...
echo.
rem Optional settings:
rem set PORT=8787
rem set HOST=0.0.0.0
rem set ALERT_PERCENT=85
rem set CODEX_LOOKBACK_DAYS=14
node server.js
echo.
echo Dashboard stopped. If you saw an error above, make sure Node.js is installed and available in PATH.
pause
