#!/usr/bin/env bash
# ============================================================
# One-time setup: initialize a git repo and connect it to GitHub.
#
# Run this on your DEV machine (where you'll be making changes).
#
# Usage:
#   ./setup-git.sh                          # initializes repo, asks for URL
#   ./setup-git.sh https://github.com/USER/REPO.git
#
# To create a NEW GitHub repo from this folder:
#   1. Go to https://github.com/new
#   2. Repository name: e.g. reddit-subscriber
#   3. Set to PRIVATE (recommended)
#   4. Do NOT initialize with README/license/.gitignore
#   5. Click "Create repository"
#   6. Copy the URL (use HTTPS for simplicity, or SSH if you have keys set up)
#   7. Run: ./setup-git.sh https://github.com/YOU/reddit-subscriber.git
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

REPO_URL="$1"

if [ -d ".git" ]; then
    echo "[info] Git repository already exists."
    if git remote -v | grep -q origin; then
        echo "[info] Remote 'origin' already configured:"
        git remote -v
        echo ""
        echo "  If you want to change it, run:"
        echo "    git remote set-url origin <new-url>"
        exit 0
    fi
else
    echo "[info] Initializing git repository..."
    git init
    git branch -M main 2>/dev/null || true
fi

# --- Get repo URL if not provided -----------------------------------------
if [ -z "$REPO_URL" ]; then
    echo ""
    echo "  Create a new repo on GitHub first:"
    echo "    https://github.com/new"
    echo ""
    echo "  Then paste the repo URL below."
    echo "  (HTTPS example: https://github.com/YOU/reddit-subscriber.git)"
    echo "  (SSH  example: git@github.com:YOU/reddit-subscriber.git)"
    echo ""
    read -p "  GitHub repo URL: " REPO_URL
    if [ -z "$REPO_URL" ]; then
        echo "[error] No URL provided. Re-run with: ./setup-git.sh <url>"
        exit 1
    fi
fi

# --- Configure remote ------------------------------------------------------
git remote remove origin 2>/dev/null || true
git remote add origin "$REPO_URL"
echo "[info] Configured remote 'origin' -> $REPO_URL"

# --- Initial commit --------------------------------------------------------
git add -A
if git diff --cached --quiet; then
    echo "[info] Nothing to commit (clean working tree)."
else
    git commit -m "initial commit" 2>&1 | sed 's/^/  /' || true
fi

# --- Push ------------------------------------------------------------------
echo "[info] Pushing to origin/main..."
git push -u origin main 2>&1 | sed 's/^/  /'

echo ""
echo "=============================================="
echo "  Git setup complete!"
echo "=============================================="
echo ""
echo "  Repo URL: $REPO_URL"
echo ""
echo "  Dev-side workflow (this machine):"
echo "    1. Make changes to files"
echo "    2. Run: ./sync.sh"
echo "    3. (Optional) Pass a commit message: ./sync.sh \"fixed X\""
echo ""
echo "  Pi-side workflow (other machine):"
echo "    1. Clone the repo once: git clone $REPO_URL reddit_subscriber_package"
echo "    2. Run: ./pull.sh to pull updates + restart the dashboard"
echo "    3. (Optional) Set up auto-pull with the systemd timer"
echo "       (see auto-pull.service in this folder)"
echo ""
