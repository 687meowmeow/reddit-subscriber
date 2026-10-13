# Reddit Mass Subreddit Subscriber

A Python script that subscribes a Reddit account to every subreddit listed in a
CSV file by **driving a real Chromium browser** via Playwright. No Reddit API
credentials needed — the script does exactly what a human would do: navigate to
each subreddit page, find the Join button, click it, wait, move on.

Plus a **Next.js dashboard** that watches the CSV file and shows live
subscription status, scraped metadata (members, description, NSFW flag), and
verification results in a searchable, filterable table.

> Designed for a fresh / burner account. Don't run this against your main account.

---

## 1. What's in this package

1. **`reddit_browser_subscriber.py`** — the Python script that subscribes to
   subreddits via Playwright. Writes per-row status to a separate `.status.csv`
   file (the input CSV is never modified).
2. **Dashboard UI** — a Next.js app in `dashboard/` that reads the status CSV
   every few seconds and shows live progress. Start/stop the script from the UI,
   enter Reddit credentials for auto-login, monitor logs in a live terminal.
3. **Helper scripts** — `start.sh` (one-command launcher), `sync.sh` (push
   changes to GitHub), `pull.sh` (manual update from GitHub).

---

## 2. Quick start

### Prerequisites

- **Python 3.9+** (`python3 --version`)
- **Node.js 18+** (`node --version`) — for the dashboard
- **Chromium** — installed automatically by Playwright on first run

### Run it

```bash
# 1. Unzip the package
unzip reddit_subscriber_package.zip
cd reddit_subscriber_package

# 2. Launch the dashboard (installs Python + Node deps automatically)
./start.sh
```

The script prints the dashboard URL — something like
`http://192.168.1.50:3100`. Open it on any device on your network.

In the dashboard:
1. Click the **gear icon** → set the CSV directory (where your CSV lives)
2. Click **"Import CSV"** to upload your subreddit list from any device
3. Enter your Reddit username + password in the Run Controls panel
4. Click **Start** — a browser window opens, logs in, and starts subscribing
5. Watch the dashboard update live as each subreddit is processed

---

## 3. How it works

The script drives a real Chromium browser via Playwright:

1. **Launch** a persistent browser profile (so you only log in once)
2. **Auto-login** if you provided credentials in the UI — otherwise prompts
   you to log in manually, then click "I'm Logged In — Continue"
3. **Pre-flight shadowban check** via `/user/{name}/about/.json` — aborts
   early if the account is shadowbanned
4. **Iterate the CSV** in priority order:
   - `pending` rows first (never been touched)
   - then `failed` / `shadowbanned` / `aborted` (retryable)
   - skip `subscribed` / `already_subscribed` (done)
   - skip `banned` / `not_found` / `private` / `quarantined` (terminal)
5. For each row: navigate to `reddit.com/r/{name}`, dismiss any NSFW/age
   interstitials, detect if already subscribed (skip if so), find the Join
   button, click it, verify the button changed to "Joined"
6. **Verify** — after the subscribe pass, fetch `/subreddits/mine/.json` and
   confirm each `subscribed` row is actually in the live subscription set

### Already-subscribed detection

Three layers of detection, in priority order:

1. **CSS selectors** — 10 patterns covering "Joined", "Leave",
   "unsubscribe-button", old Reddit's `fancy-toggle-button.remove`
2. **JavaScript evaluate** — reads the Web Component's `subscribed`
   attribute, scans inline JSON for `userIsSubscriber:true`, checks
   `window.___r` internal state, scans header text content
3. **about.json API** — fetches `/r/{name}/about.json` using the logged-in
   session cookies and checks the `user_is_subscriber` field

When detected, the row is marked `already_subscribed` and the script moves
on without clicking anything.

---

## 4. CSV format

The script auto-detects the subreddit column. Accepted column names:
`subreddit`, `subreddit_name`, `sub`, `name`, `sr`.

If no header is present, the first column is used.

**Input CSV** (your file — never modified):
```csv
subreddit
AskReddit
worldnews
pics
```

**Status CSV** (`<input>.status.csv` — generated, written to continuously):
```csv
subreddit,status,subscribed_at,verified,verified_at,members,description,is_nsfw,icon_url,error
AskReddit,subscribed,2025-10-13T05:14:22Z,verified,2025-10-13T05:15:01Z,45000000,"...",false,https://...,
worldnews,already_subscribed,2025-10-13T05:14:38Z,verified,2025-10-13T05:15:01Z,31000000,"...",false,,
pics,banned,,,2025-10-13T05:15:01Z,,,,,,subreddit banned
```

### Status values

| Status | Meaning | Retryable? |
|---|---|---|
| `pending` | Not yet processed | yes (default) |
| `subscribed` | Successfully subscribed this run | no (done) |
| `already_subscribed` | Was already subscribed before this run | no (done) |
| `failed` | Error during subscription | yes (`--reprocess-failed`) |
| `shadowbanned` | Account was shadowbanned mid-run | yes (new account) |
| `aborted` | Session cap hit before this row | yes (next run) |
| `not_found` | Subreddit doesn't exist | no (terminal) |
| `banned` | Subreddit is banned | no (terminal) |
| `private` | Subreddit is private (invite-only) | no (terminal) |
| `quarantined` | Subreddit is quarantined (requires opt-in) | no (terminal) |

---

## 5. Usage

### From the dashboard UI (recommended)

1. Open the dashboard in a browser
2. Select a CSV from the dropdown (or click "Import CSV" to upload one)
3. Enter your Reddit credentials in the Run Controls panel (optional but
   recommended — enables auto-login)
4. Click **Start**

The dashboard shows:
- Live log terminal (stdout + stderr from the Python script)
- Status badge (idle / running / waiting-for-login / completed / error)
- Stat cards (subscribed / pending / failed / terminal counts)
- Progress bar
- Filterable subreddit table with per-row status, members, description, etc.

### From the command line (advanced)

```bash
# Basic run
python3 reddit_browser_subscriber.py --csv subreddits.csv

# Headless (higher shadowban risk — not recommended)
python3 reddit_browser_subscriber.py --csv subreddits.csv --headless

# Only verify existing subscriptions (no subscribing)
python3 reddit_browser_subscriber.py --csv subreddits.csv --verify-only

# Retry rows that failed or were shadowbanned
python3 reddit_browser_subscriber.py --csv subreddits.csv --reprocess-failed

# Override the session cap (default: 100 subscribes per run)
python3 reddit_browser_subscriber.py --csv subreddits.csv --max-subscribes 200
```

---

## 6. Rate limit expectations

Reddit's web UI doesn't enforce the strict 60-req/min OAuth limit, but it
does have anti-bot rate limiting that kicks in if you go too fast.

| CSV size | Approx. wall-clock time |
|---|---|
| 50 subreddits | ~15 minutes |
| 100 subreddits (one session) | ~30 minutes |
| 500 subreddits | 5 sessions of ~30 min each, across 5 days |
| 5,000 subreddits | ~50 sessions across ~50 days |

The 100-sub/session cap is a hard limit. To go faster, run multiple accounts
in parallel (each with its own browser profile).

---

## 7. Re-running safely

The script is **resume-safe**. If you Ctrl+C it, kill it, or it crashes,
just start it again from the dashboard (or re-run the same command).

- Rows marked `subscribed` or `already_subscribed` are skipped.
- Rows marked `banned` / `not_found` / `private` / `quarantined` are skipped.
- Rows marked `failed` are skipped — use `--reprocess-failed` to retry them.
- Rows still `pending` are processed normally.
- Rows marked `shadowbanned` need a new account. Create one, then run with
  `--reprocess-failed` to reset them to `pending`.

**Priority order**: pending rows are processed first, then failed/shadowbanned/
aborted (retryable), then done/terminal rows are skipped. This means the
script gets straight to actual work instead of iterating through thousands
of already-subscribed rows.

---

## 8. Verification

After the subscribe pass, the script fetches
`https://www.reddit.com/subreddits/mine/.json` (paginated, up to 100 pages of
200 subs each = 20,000 subs max). This is the same endpoint the Reddit web UI
uses to populate your "My Communities" list.

- Each row's `verified` column is set to `verified` or `unverified`.
- Any row whose `status` claims `subscribed` but isn't in the live set is
  logged as a WARNING with the subreddit name.

To re-verify without re-subscribing:
```bash
python3 reddit_browser_subscriber.py --csv subreddits.csv --verify-only
```

---

## 9. Troubleshooting

### Browser / Playwright errors

**`Browser chromium launch failed`** or **`Executable doesn't exist at ...`**
→ Chromium isn't installed. Run:
```bash
python3 -m playwright install chromium
```
On Raspberry Pi, also install system deps:
```bash
sudo python3 -m playwright install --with-deps chromium
```

**`playwright_stealth` import error**
→ Install it: `pip install playwright-stealth`. The script works without it
(logs a warning) but you'll have less anti-detection coverage.

**Browser window doesn't appear**
→ Make sure "Headless" is OFF in the dashboard's Options panel. If running
over SSH without X11 forwarding, headful mode won't work — use `--headless`
(but accept the higher shadowban risk), or run on a real desktop.

### Login issues

**"Not logged in" even though I logged in**
→ The script's username-detection logic checks 3 places: the user menu
button's aria-label, inline `<script>` data, and `/api/v1/me`. If all fail,
it prompts you to log in manually. After logging in, click "I'm Logged In —
Continue" in the dashboard.

**Auto-login doesn't work**
→ Reddit's login form changes frequently. If auto-login fails, the script
falls back to manual login mode — the browser window stays open, you log
in by hand, then click "Continue" in the UI.

### Shadowban

**Pre-flight check fails immediately**
→ Your account is shadowbanned. Create a new burner account, update the
credentials in the dashboard, and re-run with `--reprocess-failed` to reset
the shadowbanned rows.

**Mid-run shadowban detected**
→ The script aborts, marks all pending rows as `shadowbanned`, and writes
the status CSV. Switch to a new account and re-run with `--reprocess-failed`.

### Dashboard issues

**Can't access from another device on the network**
→ The dashboard binds to `0.0.0.0:3100`. Make sure your firewall allows
incoming connections on port 3100. The `next.config.ts` includes a broad
list of private IPs in `allowedDevOrigins`. If your IP isn't covered, add
it there.

**Buttons don't work from a remote device**
→ This was caused by Next.js 16's dev-mode origin protection. Fixed by
`experimental.skipDevOriginCheck` in `next.config.ts` and the CORS headers
in `proxy.ts`.

**CSV files don't show up in the dropdown**
→ Click the gear icon → set the "CSV Directory" to the absolute path of
the folder containing your CSVs. The dashboard will auto-refresh the list.

**Page doesn't update when the script runs**
→ The dashboard polls `/api/csv-data` every 3 seconds and also refreshes
on tab focus. If it's still not updating, check the browser's network
tab for failed API calls.

---

## 10. Anti-shadowban pacing

The script mimics a careful human reading each page before clicking:

| Parameter | Default | Purpose |
|---|---|---|
| Page load wait | 4-8 seconds | Let the page fully render |
| Pre-click hover | 1-3 seconds | Mouse moves in small steps to the button |
| Post-click wait | 3-6 seconds | Let the network settle after the click |
| Inter-row delay | 8-30 seconds | Pause between subreddits |
| Batch break | every 25 subs | 60-180 second pause |
| Session cap | 100 subscribes | Hard limit per run |

Don't crank these up. The defaults are tuned to stay under Reddit's
anti-bot threshold.

---

## 11. Dashboard UI features

- **Dark mode** by default
- **CSV selector** with `.status.csv` files preferred (sorted first)
- **Import CSV** button — upload a CSV from any device (phone, laptop)
- **Stat cards** — subscribed / pending / failed / terminal counts
- **Progress bar** with color-coded segments
- **Filterable table** — search by name, filter by status, filter by NSFW
- **Live log terminal** with color-coded stdout/stderr
- **Run controls** — Start / Stop / Continue / Verify-only / Reprocess-failed
- **Settings panel** — CSV directory, Python command, GitHub auto-update
- **Debug panel** — request headers, server info, path resolution, CSV listing

---

## 12. Files

| File | Purpose |
|---|---|
| `reddit_browser_subscriber.py` | Main Python script (~2000 lines) |
| `requirements.txt` | Python deps (playwright, playwright-stealth) |
| `dashboard/` | Next.js 16 dashboard app |
| `dashboard/src/app/page.tsx` | Main dashboard UI |
| `dashboard/src/app/api/run/route.ts` | Process management API |
| `dashboard/src/app/api/csv-list/route.ts` | List CSV files |
| `dashboard/src/app/api/csv-data/route.ts` | Read CSV as JSON |
| `dashboard/src/app/api/csv-upload/route.ts` | Upload CSV from a device |
| `dashboard/src/app/api/settings/route.ts` | Read/write config |
| `dashboard/src/app/api/auto-update/route.ts` | GitHub auto-pull |
| `dashboard/src/app/api/debug/route.ts` | Diagnostics |
| `dashboard/src/proxy.ts` | CORS headers (formerly middleware.ts) |
| `dashboard/next.config.ts` | Next.js config (allowedDevOrigins) |
| `start.sh` / `start.bat` | One-command launcher |
| `setup.sh` / `setup.bat` | Install all dependencies |
| `sync.sh` | Commit + push to GitHub |
| `pull.sh` | Manual pull from GitHub |
| `setup-git.sh` | One-time git repo initialization |

---

## 13. Legal / ToS note

Using Playwright to drive your own logged-in browser session is **not**
against Reddit's Terms of Service. The script does exactly what you would
do by hand — visit each subreddit page and click Join. It does not:
- Scrape content for AI training
- Manipulate votes
- Spam
- Access other users' data
- Bypass any authentication

What IS against Reddit's ToS: mass-creating accounts, vote manipulation,
scraping for commercial use. This script does none of those.

That said, **mass-subscribing is a flagged pattern**. Use a burner account,
let it warm up, and don't push the pacing limits. If you get shadowbanned,
it's a one-strike-and-you're-out situation — there's no appeal for burner
accounts.

---

## 14. GitHub auto-update (in-app polling)

This package can automatically pull updates from GitHub while the dashboard is
running — **no systemd, no cron, no separate service**. The Next.js app itself
polls GitHub every 60 seconds and applies updates via `git reset --hard`.

### One-time setup

1. **Create a GitHub repo** at <https://github.com/new>
   - Name: e.g. `reddit-subscriber`
   - Set to **Private** (recommended)
   - Do NOT initialize with README/license/.gitignore (this folder already has them)

2. **Create a Personal Access Token (PAT)** at <https://github.com/settings/tokens>:
   - Click "Generate new token" → "Generate new token (classic)"
   - Scopes: check **`repo`** (full control of private repos)
   - Set an expiration (90 days is fine)
   - Copy the token (`ghp_xxxxxxxxx...`)

3. **Initialize git on your dev machine**:
   ```bash
   cd reddit_subscriber_package
   ./setup-git.sh https://github.com/YOUR_USERNAME/reddit-subscriber.git
   ```

4. **On the Pi, clone the repo once**:
   ```bash
   cd ~
   git clone https://github.com/YOUR_USERNAME/reddit-subscriber.git reddit_subscriber_package
   cd reddit_subscriber_package
   ./start.sh
   ```

5. **In the dashboard UI, open Settings (gear icon)**:
   - Scroll down to **GitHub Auto-Update**
   - Paste your repo URL
   - Paste your PAT
   - Toggle "Auto-pull every 60 seconds" ON
   - Click **Save**

### How it works

| What changes | What happens |
|---|---|
| Dashboard frontend (TSX/CSS) | Next.js HMR hot-reloads the page automatically |
| `next.config.ts` or `package.json` | Notification shown — restart `start.sh` to apply |
| `reddit_browser_subscriber.py` | Pulled to disk; the **next** Start uses the new code |
| `requirements.txt` | `pip install -r requirements.txt` runs automatically |
| `dashboard/package.json` deps | `npm install` runs automatically |

When an update is pulled, a blue banner appears at the top of the dashboard
showing what changed. The settings panel shows the current HEAD commit,
last check time, and recent commit messages.

**Note**: `git reset --hard` is used instead of `git pull` so local edits to
tracked files (like `start.sh`) are discarded. Your CSVs, `.config.json`,
and browser profile are in `.gitignore` and are never touched.

### Day-to-day workflow

**On the dev machine:**
```bash
./sync.sh                       # commit + push (auto-generated message)
./sync.sh "fixed scroll bug"    # commit with message + push
```

**On the Pi:**
- Nothing! The running dashboard picks up changes within 60 seconds.
- If the dashboard isn't running, the next `./start.sh` won't auto-pull
  (the polling happens client-side). Run `./pull.sh` manually if needed.

### Manual controls

In the dashboard Settings panel:
- **"Check now"** button — manually trigger a fetch + pull
- **Auto-pull toggle** — turn polling on/off without losing the saved PAT
- **Status display** — shows current HEAD, last check, recent commits

### Giving the AI assistant push access

To let me (the AI) push updates directly to your repo:

1. Complete the one-time setup above (repo created, PAT generated)
2. In our chat, paste:
   - The repo URL (e.g. `https://github.com/YOUR_USERNAME/reddit-subscriber.git`)
   - The PAT (`ghp_xxxxxxxxx...`)
3. I'll clone the repo, make changes, and push
4. The Pi auto-pulls within 60 seconds
