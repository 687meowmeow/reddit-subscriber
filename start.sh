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

# --- Step 0: Fix Pi network stability issues --------------------------------
# Two common causes of the Pi losing SSH/VNC/pi-hole connectivity:
#
# 1. Wi-Fi power management — the Pi's Wi-Fi adapter goes into power-save
#    mode during low activity and sometimes doesn't wake up. This happens
#    even when the subscriber script ISN'T running.
#
# 2. conntrack table overflow — too many TCP connections fill the kernel's
#    connection tracking table, causing the network interface to drop all
#    traffic. Default is 16384, we increase to 65536.
#
if [[ "$IS_PI" == "true" || "$OSTYPE" == "linux-gnu"* ]]; then
    # 1. Disable Wi-Fi power management
    if command -v iw >/dev/null 2>&1; then
        # Find Wi-Fi interfaces and disable power save on each
        for iface in $(iw dev 2>/dev/null | grep Interface | awk '{print $2}'); do
            iw dev "$iface" set power_save off 2>/dev/null && \
                echo "  [net] Disabled Wi-Fi power save on $iface"
        done
        # Make it persistent via NetworkManager if available
        if command -v nmcli >/dev/null 2>&1; then
            nmcli connection modify --all 802-11-wireless.powersave 2 2>/dev/null || true
        fi
    fi

    # 2. Increase conntrack table size
    CURRENT_MAX=$(cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null || echo "0")
    if [ "$CURRENT_MAX" -gt 0 ] && [ "$CURRENT_MAX" -lt 65536 ]; then
        echo "  [net] Increasing conntrack table from $CURRENT_MAX to 65536"
        echo 65536 | sudo tee /proc/sys/net/netfilter/nf_conntrack_max > /dev/null 2>/dev/null || true
        # Make persistent
        if ! grep -q 'nf_conntrack_max' /etc/sysctl.conf 2>/dev/null; then
            echo 'net.netfilter.nf_conntrack_max = 65536' | sudo tee -a /etc/sysctl.conf > /dev/null 2>/dev/null || true
        fi
    elif [ "$CURRENT_MAX" -eq 0 ]; then
        echo "  [net] nf_conntrack module not loaded — skipping (normal on some Pi setups)"
    fi

    # 3. Reduce TIME_WAIT timeout so connections close faster (default 60s → 15s)
    CURRENT_FIN=$(cat /proc/sys/net/ipv4/tcp_fin_timeout 2>/dev/null || echo "60")
    if [ "$CURRENT_FIN" -gt 15 ]; then
        echo "  [net] Reducing tcp_fin_timeout from ${CURRENT_FIN}s to 15s"
        echo 15 | sudo tee /proc/sys/net/ipv4/tcp_fin_timeout > /dev/null 2>/dev/null || true
        if ! grep -q 'tcp_fin_timeout' /etc/sysctl.conf 2>/dev/null; then
            echo 'net.ipv4.tcp_fin_timeout = 15' | sudo tee -a /etc/sysctl.conf > /dev/null 2>/dev/null || true
        fi
    fi
fi

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

    # Make sure Xvfb is installed (for virtual display when no monitor)
    if [[ "$IS_PI" == "true" ]]; then
        if ! command -v Xvfb >/dev/null 2>&1; then
            echo "  [setup] Installing Xvfb (virtual display)..."
            sudo apt install -y xvfb 2>&1 | tail -2 || true
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
