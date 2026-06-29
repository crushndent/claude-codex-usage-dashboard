@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Configuring Claude Code statusLine for this dashboard...
echo.
node setup-statusline.js %*
echo.
pause
