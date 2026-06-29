@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Installing login autostart shortcut...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $startup=[Environment]::GetFolderPath('Startup'); $lnk=$ws.CreateShortcut((Join-Path $startup 'AIUsageDashboard.lnk')); $lnk.TargetPath='wscript.exe'; $lnk.Arguments='\"%~dp0run-hidden.vbs\"'; $lnk.WorkingDirectory='%~dp0'; $lnk.Save()"
echo.
echo Installed: AIUsageDashboard.lnk
echo Starting once in the background...
start "" wscript.exe "%~dp0run-hidden.vbs"
echo.
echo Open http://YOUR-LAN-IP:8787 from a phone or tablet on the same Wi-Fi.
pause
