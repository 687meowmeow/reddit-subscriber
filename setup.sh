#!/usr/bin/env bash
# Quick setup script — installs Python + Node deps, downloads Chromium.
#
# Works on:
#   - macOS / Linux (native bash)
#   - Windows with Git Bash (https://git-scm.com/)
#   - Raspberry Pi OS (ARM64/ARMhf Linux)
#
# Usage:
#   chmod +x setup.sh
#   ./setup.sh

set -e

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PKG_DIR"

echo ""
echo "=============================================="
echo "  Reddit Subscriber — Setup"
echo "=============================================="
echo ""

# Detect OS
IS_WINDOWS=false
IS_PI=false
IS_LINUX=false
ARCH=""

if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OS" == "Windows_NT" ]]; then
    IS_WINDOWS=true
    echo "[info] Detected Windows (Git Bash / MSYS2)"
elif [[ "$OSTYPE" == "darwin"* ]]; then
    echo "[info] Detected macOS"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    IS_LINUX=true
    ARCH=$(uname -m)
    if [[ "$ARCH" == "arm"* || "$ARCH" == "aarch64" ]]; then
        IS_PI=true
        echo "[info] Detected Linux ARM ($ARCH) — likely Raspberry Pi"
    else
        echo "[info] Detected Linux ($ARCH)"
    fi
fi

# --- Detect Python ---
PY_CMD=""
for candidate in py python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
        if "$candidate" --version >/dev/null 2>&1; then
            PY_CMD="$candidate"
            echo "[info] Found Python via: $candidate"
            break
        fi
    fi
done

if [[ -z "$PY_CMD" ]]; then
    echo "[ERROR] Python not found in PATH."
    echo ""
    if [[ "$IS_WINDOWS" == "true" ]]; then
        echo "On Windows:"
        echo "  1. Install Python 3.9+ from https://python.org/"
        echo "  2. During install, check 'Add Python to PATH'"
        echo "  3. Or run setup.bat instead of setup.sh"
    elif [[ "$IS_PI" == "true" ]]; then
        echo "On Raspberry Pi:"
        echo "  sudo apt update && sudo apt install -y python3 python3-pip python3-venv"
    else
        echo "Install Python 3.9+ from https://python.org/"
    fi
    exit 1
fi
echo ""

# Show Python version
echo "[1/5] Python version:"
"$PY_CMD" --version
echo ""

# --- 2. Python deps ---
echo "[2/5] Installing Python dependencies (playwright, playwright-stealth)..."
echo "      Command: $PY_CMD -m pip install -r requirements.txt"
echo ""
"$PY_CMD" -m pip install -r requirements.txt
echo ""

# --- 2b. Virtual display tools (Linux only) ---
# Xvfb lets Chromium run in headed mode without a physical monitor.
# This is needed when the Pi boots without a desktop session.
if [[ "$IS_PI" == "true" || "$OSTYPE" == "linux-gnu"* ]]; then
    echo "[2b/5] Installing Xvfb (virtual display for headless Pi)..."
    if command -v apt >/dev/null 2>&1; then
        sudo apt install -y xvfb xset 2>&1 | tail -3
    elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y xorg-x11-server-Xvfb xset 2>&1 | tail -3
    elif command -v yum >/dev/null 2>&1; then
        sudo yum install -y xorg-x11-server-Xvfb xset 2>&1 | tail -3
    else
        echo "      [WARN] Could not detect package manager. Install xvfb manually."
    fi
    echo ""
fi

# --- 3. Chromium binary ---
echo "[3/5] Downloading Chromium browser binary for Playwright (~150MB)..."
if [[ "$IS_PI" == "true" ]]; then
    # On Raspberry Pi, we need to install system dependencies first
    # Playwright's --with-deps flag handles this on Debian-based systems
    echo "      Installing system dependencies for Chromium on ARM..."
    echo "      This may require sudo (you may be prompted for your password)."
    echo "      Command: $PY_CMD -m playwright install --with-deps chromium"
    echo ""
    "$PY_CMD" -m playwright install --with-deps chromium
else
    echo "      Command: $PY_CMD -m playwright install chromium"
    echo ""
    "$PY_CMD" -m playwright install chromium
fi
echo ""

# --- 4. Node deps ---
echo "[4/5] Installing dashboard dependencies..."
cd dashboard

PKG_CMD=""
PKG_INSTALL=""
PKG_RUN_DEV=""

for candidate in bun npm pnpm; do
    if command -v "$candidate" >/dev/null 2>&1; then
        if "$candidate" --version >/dev/null 2>&1; then
            PKG_CMD="$candidate"
            PKG_INSTALL="$candidate install"
            PKG_RUN_DEV="$candidate run dev"
            echo "[info] Found $candidate"
            break
        fi
    fi
done

# Fallback: try direct invocation (works on Windows Git Bash)
if [[ -z "$PKG_CMD" ]]; then
    if npm --version >/dev/null 2>&1; then
        PKG_CMD="npm"
        PKG_INSTALL="npm install"
        PKG_RUN_DEV="npm run dev"
        echo "[info] Found npm (via direct invocation)"
    elif pnpm --version >/dev/null 2>&1; then
        PKG_CMD="pnpm"
        PKG_INSTALL="pnpm install"
        PKG_RUN_DEV="pnpm run dev"
        echo "[info] Found pnpm (via direct invocation)"
    fi
fi

# Windows fallback: check common install locations
if [[ -z "$PKG_CMD" && "$IS_WINDOWS" == "true" ]]; then
    if [[ -f "/c/Program Files/nodejs/npm.cmd" ]]; then
        PKG_CMD="npm"
        PKG_INSTALL='"/c/Program Files/nodejs/npm.cmd" install'
        PKG_RUN_DEV='"/c/Program Files/nodejs/npm.cmd" run dev'
        echo "[info] Found npm at C:/Program Files/nodejs/"
    fi
fi

if [[ -z "$PKG_CMD" ]]; then
    echo "[ERROR] No JavaScript package manager found."
    echo ""
    if [[ "$IS_PI" == "true" ]]; then
        echo "On Raspberry Pi, install Node.js:"
        echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
        echo "  sudo apt install -y nodejs"
        echo ""
        echo "Then re-run this script."
    else
        echo "Install one of:"
        echo "  - Node.js (includes npm): https://nodejs.org/"
        echo "  - Bun:                    https://bun.sh/"
    fi
    cd ..
    exit 1
fi

echo "      Command: $PKG_INSTALL"
echo ""
$PKG_INSTALL
cd ..
echo ""

# --- 5. Done ---
echo "[5/5] Setup complete!"
echo ""
echo "=============================================="
echo "  Setup complete!"
echo "=============================================="
echo ""
echo "Next steps:"
echo ""
echo "  Just run the launcher:"
echo "    ./start.sh"
echo ""
echo "  It will start the dashboard on port 3100, accessible from any"
echo "  device on your network. The URL will be printed when it starts."
echo ""
