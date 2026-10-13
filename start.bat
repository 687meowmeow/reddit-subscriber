@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM Reddit Subscriber Dashboard - single launcher (Windows)
REM Just run this. It will install deps if needed and start the
REM dashboard on port 3100 (configurable).
REM
REM Usage:
REM   start.bat              (default port 3100)
REM   set PORT=8080 ^&^& start.bat   (custom port)
REM ============================================================

cd /d "%~dp0"

REM --- Default port ----------------------------------------------------------
if "%PORT%"=="" set PORT=3100

echo.
echo ==============================================
echo   Reddit Subscriber Dashboard
echo ==============================================
echo.
echo   Port:           %PORT%
echo   Working dir:    %~dp0
echo.

REM --- Print local IPs ------------------------------------------------------
echo   Accessible from any device on your network at:
echo.
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
    set "ip=%%a"
    set "ip=!ip: =!"
    echo     http://!ip!:%PORT%
)
echo.
echo   Or open locally: http://localhost:%PORT%
echo.
echo   Press Ctrl+C to stop.
echo.

REM --- Step 1: Install Python deps (only if missing) ------------------------
set "PYTHON_BIN="
where python >nul 2>nul
if !errorlevel! equ 0 (
    set "PYTHON_BIN=python"
) else (
    where python3 >nul 2>nul
    if !errorlevel! equ 0 (
        set "PYTHON_BIN=python3"
    )
)

if not "%PYTHON_BIN%"=="" (
    if exist "%~dp0requirements.txt" (
        "%PYTHON_BIN%" -c "import playwright" >nul 2>nul
        if !errorlevel! neq 0 (
            echo   [setup] Installing Python dependencies ^(one-time^)...
            "%PYTHON_BIN%" -m pip install -r "%~dp0requirements.txt" --quiet
            echo   [setup] Ensuring Playwright Chromium is installed...
            "%PYTHON_BIN%" -m playwright install chromium >nul 2>nul
        )
    )
)

REM --- Step 2: Install Node deps (only if missing) --------------------------
cd /d "%~dp0dashboard"

if not exist "node_modules" (
    set "PKG_MGR="
    where npm >nul 2>nul
    if !errorlevel! equ 0 (
        set "PKG_MGR=npm"
    ) else (
        where bun >nul 2>nul
        if !errorlevel! equ 0 (
            set "PKG_MGR=bun"
        )
    )

    if "!PKG_MGR!"=="" (
        echo   [ERROR] Neither npm nor bun found.
        echo           Install Node.js from https://nodejs.org/
        pause
        exit /b 1
    )

    echo   [setup] Installing Node dependencies via !PKG_MGR! ^(one-time^)...
    "!PKG_MGR!" install
)

REM --- Step 3: Launch Next.js dev server -------------------------------------
echo.
echo   [launch] Starting Next.js on 0.0.0.0:%PORT% ...
echo.

where bun >nul 2>nul
if !errorlevel! equ 0 (
    if exist "bun.lock" (
        bun run dev
        goto :eof
    )
)
where npm >nul 2>nul
if !errorlevel! equ 0 (
    npm run dev
    goto :eof
)

echo   [ERROR] No package manager available to run the dev server.
pause
exit /b 1
