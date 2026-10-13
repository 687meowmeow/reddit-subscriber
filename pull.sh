#!/usr/bin/env bash
# ============================================================
# Pi-side update script — pulls latest changes from GitHub
# and restarts the dashboard.
#
# Usage:
#   ./pull.sh                # pull and restart dashboard
#   ./pull.sh --no-restart   # pull only, don't restart
#   ./pull.sh --check        # check for updates without applying
#
# If you set up the systemd timer (auto-pull.service), this
# script runs automatically every 60 seconds.
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# --- Flags -----------------------------------------------------------------
NO_RESTART=false
CHECK_ONLY=false
for arg in "$@"; do
    case "$arg" in
        --no-restart) NO_RESTART=true ;;
        --check)      CHECK_ONLY=true ;;
    esac
done

# --- Make sure we're in a git repo ----------------------------------------
if [ ! -d ".git" ]; then
    echo "[error] This directory is not a git repository."
    echo "        Run ./setup-git.sh first, OR clone your repo here:"
    echo "          git clone <your-repo-url> ."
    exit 1
fi

# --- Check git is available -----------------------------------------------
if ! command -v git >/dev/null 2>&1; then
    echo "[error] git not found. Install with:"
    echo "  sudo apt install -y git"
    exit 1
fi

# --- Get current branch ----------------------------------------------------
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'main')"
echo "[info] On branch: $BRANCH"

# --- Fetch latest from remote ----------------------------------------------
echo "[info] Fetching latest from origin..."
git fetch origin "$BRANCH" 2>&1 | sed 's/^/  /'

# --- Compare local vs remote -----------------------------------------------
LOCAL="$(git rev-parse HEAD 2>/dev/null || echo '')"
REMOTE="$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo '')"

if [ -z "$LOCAL" ] || [ -z "$REMOTE" ]; then
    echo "[error] Could not determine local/remote commit hashes."
    exit 1
fi

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "[info] Already up to date. ($LOCAL)"
    exit 0
fi

echo "[info] Updates available:"
echo "         local:  $LOCAL"
echo "         remote: $REMOTE"

# Show what changed
echo ""
echo "[info] Changes:"
git log --oneline "$LOCAL".."$REMOTE" 2>/dev/null | head -20 | sed 's/^/  /'
echo ""

if [ "$CHECK_ONLY" = "true" ]; then
    echo "[info] --check given, not applying. Run ./pull.sh to apply."
    exit 0
fi

# --- Apply the update ------------------------------------------------------
echo "[info] Pulling changes..."
git pull origin "$BRANCH" 2>&1 | sed 's/^/  /'

# --- Install any new dependencies -----------------------------------------
echo ""
echo "[info] Checking for new dependencies..."

# Python
PY_CMD=""
if command -v python3 >/dev/null 2>&1; then
    PY_CMD="python3"
elif command -v python >/dev/null 2>&1; then
    PY_CMD="python"
fi
if [ -n "$PY_CMD" ] && [ -f "requirements.txt" ]; then
    if ! "$PY_CMD" -c "import playwright" >/dev/null 2>&1; then
        echo "  [setup] Installing missing Python deps..."
        "$PY_CMD" -m pip install -r requirements.txt --quiet 2>&1 | tail -3
        "$PY_CMD" -m playwright install chromium 2>&1 | tail -2 || true
    fi
fi

# Node
if [ -d "dashboard" ] && [ ! -d "dashboard/node_modules" ]; then
    echo "  [setup] Installing Node deps..."
    cd dashboard
    if command -v npm >/dev/null 2>&1; then
        npm install 2>&1 | tail -3
    elif command -v bun >/dev/null 2>&1; then
        bun install 2>&1 | tail -3
    fi
    cd ..
fi

# --- Restart the dashboard -------------------------------------------------
if [ "$NO_RESTART" = "true" ]; then
    echo ""
    echo "[info] --no-restart given, not restarting the dashboard."
    exit 0
fi

echo ""
echo "[info] Restarting dashboard..."

# Try systemctl first (if running as a service)
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q "reddit-subscriber"; then
    sudo systemctl restart reddit-subscriber 2>&1 | sed 's/^/  /' || true
    echo "[info] Dashboard restarted via systemctl."
    exit 0
fi

# Otherwise, look for the running start.sh process and kill it
PIDS="$(pgrep -f 'start\.sh|next dev' 2>/dev/null || true)"
if [ -n "$PIDS" ]; then
    echo "  [info] Found running dashboard processes: $PIDS"
    echo "  [info] Stopping them..."
    for pid in $PIDS; do
        kill "$pid" 2>/dev/null || true
    done
    sleep 2
    # Force kill if still running
    for pid in $PIDS; do
        if kill -0 "$pid" 2>/dev/null; then
            kill -9 "$pid" 2>/dev/null || true
        fi
    done
    echo "  [info] Old processes stopped."
fi

# Start fresh in the background
echo "  [info] Starting dashboard in background..."
nohup ./start.sh > /tmp/reddit-subscriber.log 2>&1 &
echo "  [info] Dashboard started. Log: /tmp/reddit-subscriber.log"
echo "  [info] PID: $!"
echo ""
echo "  Accessible at http://$(hostname -I | awk '{print $1}'):${PORT:-3100}"
