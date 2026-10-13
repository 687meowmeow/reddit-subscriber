@echo off
REM ============================================================================
REM  Reddit Subscriber - Windows Setup
REM ============================================================================
REM  Double-click this file, or run from cmd/PowerShell/Git Bash:
REM    setup.bat
REM
REM  Requirements:
REM    - Python 3.9+ (https://python.org) - check "Add to PATH" during install
REM    - Node.js 18+ (https://nodejs.org) OR Bun (https://bun.sh)
REM ============================================================================

setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo ==============================================
echo   Reddit Subscriber - Windows Setup
echo ==============================================
echo.

REM --- Detect Python ---
set "PY_CMD="
for %%c in (py python3 python) do (
    if not defined PY_CMD (
        where %%c >nul 2>nul
        if !errorlevel! equ 0 (
            REM Verify it actually runs (not the Windows Store stub)
            %%c --version >nul 2>nul
            if !errorlevel! equ 0 (
                set "PY_CMD=%%c"
            )
        )
    )
)

if not defined PY_CMD (
    echo [ERROR] Python not found in PATH.
    echo.
    echo Install Python 3.9+ from https://python.org/
    echo IMPORTANT: Check "Add Python to PATH" during install.
    echo.
    echo If you already have Python installed:
    echo   1. Close this window
    echo   2. Reopen cmd (so PATH changes take effect)
    echo   3. Re-run setup.bat
    echo.
    pause
    exit /b 1
)

echo [info] Using Python: !PY_CMD!
echo.

REM --- Verify Python version ---
echo [1/4] Checking Python version...
!PY_CMD! --version
if !errorlevel! neq 0 (
    echo [ERROR] Could not run !PY_CMD!. Check your Python install.
    pause
    exit /b 1
)
echo.

REM --- Step 2: Install Python dependencies ---
echo [2/4] Installing Python dependencies ^(playwright, playwright-stealth^)...
echo       Command: !PY_CMD! -m pip install -r requirements.txt
echo.
!PY_CMD! -m pip install -r requirements.txt
if !errorlevel! neq 0 (
    echo.
    echo [ERROR] pip install failed.
    echo.
    echo Common fixes:
    echo   1. Try upgrading pip first:
    echo        !PY_CMD! -m pip install --upgrade pip
    echo   2. Try installing packages one at a time:
    echo        !PY_CMD! -m pip install playwright
    echo        !PY_CMD! -m pip install playwright-stealth
    echo   3. If you get permission errors, try:
    echo        !PY_CMD! -m pip install --user -r requirements.txt
    echo.
    pause
    exit /b 1
)
echo.

REM --- Step 3: Download Chromium for Playwright ---
echo [3/4] Downloading Chromium browser binary for Playwright ~150MB^)...
echo       This may take a few minutes depending on your connection.
echo       Command: !PY_CMD! -m playwright install chromium
echo.
!PY_CMD! -m playwright install chromium
if !errorlevel! neq 0 (
    echo.
    echo [ERROR] Playwright Chromium install failed.
    echo.
    echo Common causes and fixes:
    echo.
    echo   1. Network/proxy issue - try running manually:
    echo        !PY_CMD! -m playwright install chromium
    echo      If behind a proxy, set HTTP_PROXY/HTTPS_PROXY env vars first.
    echo.
    echo   2. Antivirus blocking - temporarily disable AV, then retry.
    echo.
    echo   3. Disk space - ensure you have ~500MB free.
    echo.
    echo   4. Permission denied - try with admin rights:
    echo        Right-click cmd -^> "Run as administrator" -^> re-run setup.bat
    echo.
    pause
    exit /b 1
)
echo.

REM --- Step 4: Install dashboard dependencies ---
echo [4/4] Installing dashboard dependencies...
cd dashboard

REM --- Detect package manager (using delayed expansion !errorlevel!) ---
set "PKG_CMD="
set "PKG_INSTALL="
set "PKG_RUN_DEV="

REM Try bun first
where bun >nul 2>nul
if !errorlevel! equ 0 (
    set "PKG_CMD=bun"
    set "PKG_INSTALL=bun install"
    set "PKG_RUN_DEV=bun run dev"
    echo [info] Found bun
)

REM Try npm if bun wasn't found
if not defined PKG_CMD (
    where npm >nul 2>nul
    if !errorlevel! equ 0 (
        set "PKG_CMD=npm"
        set "PKG_INSTALL=npm install"
        set "PKG_RUN_DEV=npm run dev"
        echo [info] Found npm
    )
)

REM Try pnpm if neither bun nor npm was found
if not defined PKG_CMD (
    where pnpm >nul 2>nul
    if !errorlevel! equ 0 (
        set "PKG_CMD=pnpm"
        set "PKG_INSTALL=pnpm install"
        set "PKG_RUN_DEV=pnpm run dev"
        echo [info] Found pnpm
    )
)

REM Fallback: check if node.exe exists (sometimes npm isn't in PATH but node is)
if not defined PKG_CMD (
    where node >nul 2>nul
    if !errorlevel! equ 0 (
        echo [info] Found node but not npm - trying npm directly...
        REM npm.cmd is usually in the same dir as node
        call npm --version >nul 2>nul
        if !errorlevel! equ 0 (
            set "PKG_CMD=npm"
            set "PKG_INSTALL=npm install"
            set "PKG_RUN_DEV=npm run dev"
            echo [info] npm works via call
        )
    )
)

REM Last resort: check common install locations
if not defined PKG_CMD (
    if exist "C:\Program Files\nodejs\npm.cmd" (
        set "PKG_CMD=npm"
        set "PKG_INSTALL=C:\Program Files\nodejs\npm.cmd install"
        set "PKG_RUN_DEV=C:\Program Files\nodejs\npm.cmd run dev"
        echo [info] Found npm at C:\Program Files\nodejs\
    )
    if exist "%LOCALAPPDATA%\Programs\nodejs\npm.cmd" (
        set "PKG_CMD=npm"
        set "PKG_INSTALL=%LOCALAPPDATA%\Programs\nodejs\npm.cmd install"
        set "PKG_RUN_DEV=%LOCALAPPDATA%\Programs\nodejs\npm.cmd run dev"
        echo [info] Found npm at %LOCALAPPDATA%\Programs\nodejs\
    )
)

if not defined PKG_CMD (
    echo.
    echo [ERROR] No JavaScript package manager found in PATH.
    echo.
    echo You said you have Node.js installed. The issue is that npm isn't in
    echo your current cmd session's PATH. Fixes:
    echo.
    echo   1. CLOSE this cmd window and OPEN A NEW ONE.
    echo      ^(PATH changes from a recent Node.js install don't apply to
    echo      already-open cmd windows.^)
    echo      Then re-run setup.bat.
    echo.
    echo   2. If that doesn't work, run manually:
    echo        cd dashboard
    echo        npm install
    echo.
    echo   3. Or check if npm is installed but PATH is broken:
    echo        where node       REM should print a path
    echo        where npm        REM should print a path with npm.cmd
    echo      If 'where node' works but 'where npm' doesn't:
    echo        - Reinstall Node.js from https://nodejs.org/
    echo        - OR add the nodejs directory to PATH manually
    echo.
    cd ..
    pause
    exit /b 1
)

echo       Command: !PKG_INSTALL!
echo.
call !PKG_INSTALL!
if !errorlevel! neq 0 (
    echo.
    echo [ERROR] Dashboard dependency install failed.
    echo.
    echo Try running manually:
    echo   cd dashboard
    echo   !PKG_INSTALL!
    echo.
    cd ..
    pause
    exit /b 1
)

cd ..
echo.

REM --- Done ---
echo ==============================================
echo   Setup complete!
echo ==============================================
echo.
echo IMPORTANT - one thing you MUST do before running:
echo.
echo   Edit these two files and change ALLOWED_ROOT to the absolute path
echo   of THIS directory ^(where reddit_browser_subscriber.py lives^):
echo.
echo     dashboard\src\app\api\csv-data\route.ts
echo     dashboard\src\app\api\csv-list\route.ts
echo.
echo   The path should look like:
echo     C:\Users\YourName\reddit_subscriber_package
echo.
echo   ^(Use double backslashes in the TypeScript string, e.g.:
echo      "C:\\Users\\YourName\\reddit_subscriber_package"  ^)
echo.
echo Next steps:
echo.
echo   1. Open TWO terminals ^(cmd, PowerShell, or Git Bash - all work^):
echo.
echo      Terminal 1 ^(dashboard^):
echo        cd dashboard
echo        !PKG_RUN_DEV!
echo.
echo      Terminal 2 ^(subscriber^):
echo        !PY_CMD! reddit_browser_subscriber.py --csv subreddits_sample.csv
echo.
echo   2. Open http://localhost:3000 in your browser.
echo.
echo   3. When the script's browser window opens, log in to your Reddit
echo      burner account by hand. Then press Enter in the terminal.
echo.
echo   4. Watch the dashboard update live as it subscribes.
echo.
pause
