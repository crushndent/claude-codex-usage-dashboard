@echo off
chcp 65001 >nul
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AIUsageDashboard.lnk" 2>nul
echo Removed AIUsageDashboard.lnk from the Startup folder.
echo If the server is still running, end node.exe from Task Manager or restart Windows.
pause
