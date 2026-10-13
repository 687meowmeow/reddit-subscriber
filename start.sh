#!/usr/bin/env bash
# ============================================================
# Reddit Subscriber Dashboard — single launcher
# ------------------------------------------------------------
# Just run this script. It will:
#   1. Make sure Python deps are installed (playwright, etc.)
#   2. Make sure Chromium is installed for Playwright
#   3. Make sure Node deps are installed (npm install)
#   4. Start the Next.js dashboard on port 3100 (configurable)
#   5. Print the URL you can use from any device on your network
#
# Usage:
#   ./start.sh                  # uses default port 3100
#   PORT=8080 ./start.sh        # custom port
#
# On Windows, use start.bat instead.
# ============================================================

set -e

# --- Resolve script directory ----------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# --- Default port ----------------------------------------------------------
export PORT="${PORT:-3100}"

# --- Detect OS -------------------------------------------------------------
IS_PI=false
ARCH=""
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    ARCH=$(uname -m)
    if [[ "$ARCH" == "arm"* || "$ARCH" == "aarch64" ]]; then
        IS_PI=true
    fi
fi

echo ""
echo "=============================================="
echo "  Reddit Subscriber Dashboard"
echo "=============================================="
echo ""
echo "  Port:           $PORT"
echo "  Working dir:    $SCRIPT_DIR"
if [[ "$IS_PI" == "true" ]]; then
    echo "  Platform:       Linux ARM ($ARCH) — Raspberry Pi detected"
else
    echo "  Platform:       $(uname -s) $(uname -m)"
fi
echo ""

# --- Print local IPs so the user knows what to type on other devices -------
echo "  Accessible from any device on your network at:"
echo ""
if command -v hostname >/dev/null 2>&1 && hostname -I >/dev/null 2>&1; then
    for ip in $(hostname -I 2>/dev/null); do
        # skip loopback / link-local
        case "$ip" in
            127.*|169.254.*) continue ;;
        esac
        echo "    http://$ip:$PORT"
    done
elif command -v ipconfig >/dev/null 2>&1; then
    # macOS
    iface_ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
    [ -n "$iface_ip" ] && echo "    http://$iface_ip:$PORT"
fi
echo ""
echo "  Or open locally: http://localhost:$PORT"
echo ""
echo "  Press Ctrl+C to stop."
echo ""

# --- Step 1: Install Python deps (only if missing) -------------------------
PYTHON_BIN=""
if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
    PYTHON_BIN="python"
else
    echo "  [WARN] Python not found on PATH. The UI will still start,"
    echo "         but the subscriber script will fail to run."
    if [[ "$IS_PI" == "true" ]]; then
        echo "         On Raspberry Pi, install Python with:"
        echo "           sudo apt update && sudo apt install -y python3 python3-pip python3-venv"
    fi
fi

if [ -n "$PYTHON_BIN" ] && [ -f "$SCRIPT_DIR/requirements.txt" ]; then
    # Check if playwright is installed
    if ! "$PYTHON_BIN" -c "import playwright" >/dev/null 2>&1; then
        echo "  [setup] Installing Python dependencies (one-time)..."
        "$PYTHON_BIN" -m pip install -r "$SCRIPT_DIR/requirements.txt" --quiet || {
            echo "  [WARN] pip install failed. The UI will still start, but"
            echo "         the subscriber script may not run. Try running:"
            echo "         $PYTHON_BIN -m pip install -r requirements.txt"
        }
    fi

    # Make sure Chromium is installed for Playwright
    if "$PYTHON_BIN" -c "import playwright" >/dev/null 2>&1; then
        if ! "$PYTHON_BIN" -c "from playwright.sync_api import sync_playwright; p=sync_playwright().start(); p.chromium.executable_path; p.stop()" >/dev/null 2>&1; then
            echo "  [setup] Installing Playwright Chromium browser..."
            if [[ "$IS_PI" == "true" ]]; then
                # On Pi, --with-deps installs required system libraries
                # This needs sudo for apt
                echo "         (Installing system deps — may prompt for sudo password)"
                sudo "$PYTHON_BIN" -m playwright install --with-deps chromium 2>&1 | tail -3 || {
                    echo "  [WARN] Chromium install with --with-deps failed. Trying without..."
                    "$PYTHON_BIN" -m playwright install chromium 2>&1 | tail -3 || true
                }
            else
                "$PYTHON_BIN" -m playwright install chromium 2>&1 | tail -3 || true
            fi
        fi
    fi
fi

# --- Step 2: Install Node deps (only if node_modules missing) --------------
cd "$SCRIPT_DIR/dashboard"

if [ -d "node_modules" ]; then
    echo "  [setup] Node modules already installed."
else
    PKG_MGR=""
    if command -v npm >/dev/null 2>&1; then
        PKG_MGR="npm"
    elif command -v bun >/dev/null 2>&1; then
        PKG_MGR="bun"
    else
        echo "  [ERROR] Neither npm nor bun found."
        if [[ "$IS_PI" == "true" ]]; then
            echo "         On Raspberry Pi, install Node.js with:"
            echo "           curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
            echo "           sudo apt install -y nodejs"
        else
            echo "         Install Node.js from https://nodejs.org/ and try again."
        fi
        exit 1
    fi

    echo "  [setup] Installing Node dependencies via $PKG_MGR (one-time)..."
    "$PKG_MGR" install 2>&1 | tail -5 || {
        echo "  [WARN] $PKG_MGR install reported errors. Trying to continue..."
    }
fi

# --- Step 3: Launch Next.js dev server -------------------------------------
echo ""
echo "  [launch] Starting Next.js on 0.0.0.0:$PORT ..."
echo ""

# Use bun if available and bun.lock exists, otherwise npm
if command -v bun >/dev/null 2>&1 && [ -f "bun.lock" ]; then
    exec bun run dev
elif command -v npm >/dev/null 2>&1; then
    exec npm run dev
else
    echo "  [ERROR] No package manager available to run the dev server."
    exit 1
fi
