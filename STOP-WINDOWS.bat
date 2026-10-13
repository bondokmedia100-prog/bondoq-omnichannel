@echo off
setlocal
cd /d "%~dp0"

where docker >nul 2>nul
if errorlevel 1 (
  echo Docker Desktop is required to stop Bondoq.
  pause
  exit /b 1
)

docker compose down
if errorlevel 1 (
  echo Could not stop the services. Make sure Docker Desktop is running.
  pause
  exit /b 1
)

echo Bondoq has stopped. Your local data has been kept.
pause
