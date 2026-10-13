@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Python 3.10 or newer is required for public-page browser extraction.
    echo Install Python and Google Chrome, then run this script again.
    pause
    exit /b 1
  )
  python -m venv .venv
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
".venv\Scripts\python.exe" -m ensurepip --upgrade
".venv\Scripts\python.exe" -m pip install -r requirements-browser.txt
if errorlevel 1 (
  pause
  exit /b 1
)
echo Browser extraction dependencies are ready. Google Chrome must be installed.
echo Restart ClipDock with start.cmd.
pause
