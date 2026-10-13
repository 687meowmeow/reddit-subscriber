#!/usr/bin/env bash
# ============================================================
# Dev-side sync script — commits and pushes changes to GitHub.
#
# Reads the PAT from dashboard/.config.json (the same one set
# via the dashboard UI). If no PAT is stored, falls back to
# git's default credential helper (SSH keys, credential manager,
# or interactive prompt).
#
# Usage:
#   ./sync.sh                       # commit + push (auto-generated message)
#   ./sync.sh "fixed the thing"     # commit with message + push
#   ./sync.sh --no-push             # commit only
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# --- Make sure we're in a git repo ----------------------------------------
if [ ! -d ".git" ]; then
    echo "[error] Not a git repository."
    echo "        First time? Run ./setup-git.sh to initialize and"
    echo "        connect to a GitHub repo."
    exit 1
fi

# --- Parse args ------------------------------------------------------------
PUSH=true
COMMIT_MSG=""
for arg in "$@"; do
    case "$arg" in
        --no-push) PUSH=false ;;
        *)         COMMIT_MSG="$arg" ;;
    esac
done

# --- Try to read PAT from .config.json ------------------------------------
# This is the same PAT stored via the dashboard UI's GitHub panel
PAT=""
CONFIG_FILE="$SCRIPT_DIR/dashboard/.config.json"
if [ -f "$CONFIG_FILE" ]; then
    # Use python to parse JSON (works on all platforms)
    if command -v python3 >/dev/null 2>&1; then
        PAT="$(python3 -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('githubPat',''))" 2>/dev/null || echo '')"
    elif command -v python >/dev/null 2>&1; then
        PAT="$(python -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('githubPat',''))" 2>/dev/null || echo '')"
    fi
fi

# --- Get the remote URL ----------------------------------------------------
REMOTE_URL="$(git remote get-url origin 2>/dev/null || echo '')"
if [ -z "$REMOTE_URL" ]; then
    echo "[error] No 'origin' remote configured."
    echo "        Run: ./setup-git.sh https://github.com/USER/REPO.git"
    exit 1
fi

# If we have a PAT and the URL is HTTPS, inject the PAT into the URL
# so git push works without prompting for credentials.
if [ -n "$PAT" ] && [[ "$REMOTE_URL" == https://* ]] && ! echo "$REMOTE_URL" | grep -q "@"; then
    AUTHED_URL="${REMOTE_URL/https:\/\//https:\/\/$PAT@}"
    git remote set-url origin "$AUTHED_URL"
    # Restore the original URL after we're done (so the PAT doesn't leak
    # into git's config file permanently)
    trap 'git remote set-url origin "$REMOTE_URL" 2>/dev/null || true' EXIT
    echo "[info] Using PAT from .config.json for authentication."
else
    echo "[info] Using git's default credentials (SSH key or credential helper)."
fi

# --- Status ----------------------------------------------------------------
echo ""
echo "[info] Current git status:"
git status --short
echo ""

# --- Stage all changes (including new files) -------------------------------
git add -A
echo "[info] Staged changes."

# --- Commit if there's anything to commit ---------------------------------
if git diff --cached --quiet; then
    echo "[info] Nothing to commit. Working tree clean."
else
    if [ -z "$COMMIT_MSG" ]; then
        # Generate a default commit message from the changes
        COMMIT_MSG="update $(date +%Y-%m-%d_%H:%M:%S)"
    fi
    git commit -m "$COMMIT_MSG" 2>&1 | sed 's/^/  /'
    echo "[info] Committed: $COMMIT_MSG"
fi

# --- Push ------------------------------------------------------------------
if [ "$PUSH" = "true" ]; then
    BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'main')"
    echo "[info] Pushing to origin/$BRANCH..."
    git push origin "$BRANCH" 2>&1 | sed 's/^/  /'
    echo "[info] Pushed."
    echo ""
    echo "  The Pi will auto-pull these changes within 60 seconds (if the"
    echo "  dashboard is running with auto-update enabled)."
else
    echo "[info] --no-push given, not pushing."
fi
