@echo off
rem Double-click to start the auto-monitoring web app (http://127.0.0.1:8770/). Close this window to stop it.
chcp 65001 >nul
cd /d "%~dp0"
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://127.0.0.1:8770/"
node --disable-warning=ExperimentalWarning app\server.mjs
pause
