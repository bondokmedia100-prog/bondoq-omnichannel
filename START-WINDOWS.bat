@echo off
setlocal
cd /d "%~dp0"

where docker >nul 2>nul
if errorlevel 1 (
  echo Docker Desktop is required. Install it from https://www.docker.com/products/docker-desktop/
  echo Then restart Windows, open Docker Desktop, and run this file again.
  pause
  exit /b 1
)

docker info >nul 2>nul
if errorlevel 1 (
  echo Docker Desktop is installed but is not running.
  echo Open Docker Desktop, wait until it says it is running, then run this file again.
  pause
  exit /b 1
)

docker compose version >nul 2>nul
if errorlevel 1 (
  echo Docker Compose is unavailable. Update Docker Desktop and try again.
  pause
  exit /b 1
)

echo Building and starting Bondoq. The first start can take several minutes.
docker compose up --build -d
if errorlevel 1 goto failed

echo.
echo Waiting for the dashboard to become ready...
set /a attempts=0
:wait_for_web
curl.exe --silent --fail "http://localhost:3000/" -o nul >nul 2>nul
if not errorlevel 1 goto open_web
set /a attempts+=1
if %attempts% GEQ 40 goto open_web
timeout /t 3 /nobreak >nul
goto wait_for_web

:open_web
echo The local dashboard is http://localhost:3000
start "Bondoq" "http://localhost:3000"
echo To stop Bondoq later, run STOP-WINDOWS.bat. Your data will be kept.
pause
exit /b 0

:failed
echo.
echo Startup failed. Check the Docker Desktop status and your internet connection, then try again.
echo If it still fails, open a terminal in this folder and run: docker compose logs
pause
exit /b 1
