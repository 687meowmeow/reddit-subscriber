# Reddit Mass Subreddit Subscriber — Full Package

This package contains everything you need to mass-subscribe to subreddits
from a CSV using browser automation (no Reddit API approval required),
plus a live dashboard UI to watch the progress in real time.

## What's inside

```
reddit_subscriber_package/
├── reddit_browser_subscriber.py    # The Python script (Playwright-based)
├── requirements.txt                # Python deps: playwright, playwright-stealth
├── README.md                       # Full documentation for the script
├── subreddits_sample.csv           # Example input (just subreddit names)
├── subreddits_sample.status.csv    # Example status file (for testing the dashboard)
└── dashboard/                      # Next.js dashboard UI
    ├── package.json
    ├── tsconfig.json
    ├── next.config.ts
    ├── tailwind.config.ts
    ├── postcss.config.mjs
    ├── eslint.config.mjs
    ├── components.json
    └── src/
        ├── app/
        │   ├── page.tsx             # Dashboard UI (dark mode by default)
        │   ├── layout.tsx           # Root layout (dark mode + suppressHydrationWarning)
        │   ├── globals.css         # Tailwind + theme variables
        │   └── api/
        │       ├── csv-data/route.ts   # API: read a CSV as JSON
        │       └── csv-list/route.ts    # API: list CSV files
        ├── components/ui/           # shadcn/ui components (65 files)
        ├── lib/utils.ts            # cn() helper
        └── hooks/                   # use-mobile, use-toast
```

## Quick start

### Option A: Use the setup script (recommended)

**Windows** (cmd, PowerShell, or Git Bash):
```
Double-click setup.bat
```

**macOS / Linux**:
```bash
chmod +x setup.sh
./setup.sh
```

The setup script:
1. Detects your Python (`py`, `python3`, or `python`)
2. Installs Python dependencies (`playwright`, `playwright-stealth`)
3. Downloads the Chromium browser binary (~150MB)
4. Installs the dashboard's Node dependencies (via `bun`, `npm`, or `pnpm`)

If the setup script fails on a specific step, see **Troubleshooting** below.

### Option B: Manual setup

If the setup script doesn't work for you, run these commands manually:

#### Part 1: Set up the subscriber script

```bash
cd reddit_subscriber_package
pip install -r requirements.txt      # or: python -m pip install -r requirements.txt
python -m playwright install chromium  # or: py -m playwright install chromium
```

#### Part 2: Set up the dashboard

```bash
cd dashboard
bun install   # or: npm install
```

(Use whichever package manager you have. `bun` is fastest, `npm` works too.)

### Part 3: Run both

Open **two terminals**:

**Terminal 1 — the dashboard:**
```bash
cd dashboard
bun run dev
```
Opens at http://localhost:3000 (dark mode).

**Terminal 2 — the subscriber:**
```bash
cd reddit_subscriber_package
python reddit_browser_subscriber.py --csv subreddits_sample.csv
```

The script will:
1. Open a Chromium window
2. Navigate to reddit.com
3. Detect you're not logged in (or skip if you are)
4. Prompt you to log in manually
5. Press Enter to begin subscribing
6. Watch the dashboard update live as it processes each subreddit

The script reads your input CSV (`subreddits_sample.csv`) once and writes
status updates to a separate file (`subreddits_sample.status.csv`).
The input is **never modified**.

## Features

- **Browser automation** — drives a real Chromium browser, no API approval needed
- **Non-destructive** — input CSV is read-only; status writes go to a separate file
- **Per-row status tracking** — subscribed / failed / not_found / banned / private /
  quarantined / shadowbanned / aborted
- **Continue-on-error** — never aborts on a per-row error; marks failed and moves on
- **Subreddit metadata scraping** — members, description, created date, NSFW flag,
  icon URL (extracted during the subscribe pass, no extra requests)
- **Shadowban detection** — pre-flight check + mid-run re-check after 5 consecutive
  failures; aborts cleanly if shadowbanned
- **Resume safety** — kill it / crash it / Ctrl+C; re-run the same command to resume
- **Live dashboard** — dark mode by default, polls every 5 seconds, filters by
  status category, search by name, filter by NSFW
- **CSV selector** — dashboard auto-prefers `.status.csv` files (shown with a
  green STATUS badge), hides bare input `.csv` files when a status file exists
- **Hydration-safe** — `suppressHydrationWarning` on the affected div silences
  warnings from password-manager extensions (ProtonPass, LastPass, etc.)

## Key commands

```bash
# Full run (subscribe + verify)
python reddit_browser_subscriber.py --csv subreddits.csv

# Verify-only (re-check the CSV against your live subscriptions)
python reddit_browser_subscriber.py --csv subreddits.csv --verify-only

# Retry rows that previously failed OR were shadowbanned
python reddit_browser_subscriber.py --csv subreddits.csv --reprocess-failed

# Increase session cap (risky — higher shadowban chance)
python reddit_browser_subscriber.py --csv subreddits.csv --max-subscribes 200

# Use a custom status file path
python reddit_browser_subscriber.py --csv subreddits.csv \
    --status-csv /path/to/my_status.csv
```

## How the dashboard works

The dashboard has two API routes:

- `GET /api/csv-list` — lists all `.csv` files in the same directory as
  `reddit_browser_subscriber.py`. Status files (`.status.csv`) are sorted
  first and labeled with a STATUS badge.
- `GET /api/csv-data?csv=NAME` — reads the named CSV, parses it (handles
  quoted fields, auto-detects headers), and returns JSON.

**Important**: The API's `ALLOWED_ROOT` is hardcoded to a path like
`/home/z/my-project/download/reddit_subscriber/`. When you unpack this zip,
you **MUST** edit the `ALLOWED_ROOT` constant in:

- `dashboard/src/app/api/csv-data/route.ts`
- `dashboard/src/app/api/csv-list/route.ts`

Change it to the absolute path of the directory where you unpacked the zip
(the directory that contains `reddit_browser_subscriber.py`).

## Troubleshooting

### Setup step 2 fails on Windows (`playwright install chromium`)

This is the most common issue on Windows. Causes and fixes:

**1. `python` points to the Windows Store stub**

In Git Bash, typing `python` sometimes opens the Microsoft Store instead of
running Python. Fix:
- Use `py` instead of `python` (the Python launcher, installed with Python)
- Or run `setup.bat` instead of `setup.sh` — it detects `py` automatically
- Or disable the Windows Store stub: Settings → Apps → App execution
  aliases → turn off "python.exe" and "python3.exe"

Test which one works:
```bash
py --version            # should print Python 3.x.x
python --version        # might open Microsoft Store — don't use this one
```

Then install Chromium with the working command:
```bash
py -m playwright install chromium
```

**2. Playwright package wasn't actually installed**

Sometimes `pip install -r requirements.txt` succeeds but `playwright`
isn't in the right Python. Verify:
```bash
py -c "import playwright; print(playwright.__version__)"
```

If that fails, install explicitly:
```bash
py -m pip install playwright playwright-stealth
```

**3. Network/proxy issues downloading Chromium**

The Chromium binary (~150MB) downloads from
`https://playwright.azureedge.net/`. If you're behind a proxy:
```bash
# Set proxy env vars before running install
export HTTP_PROXY=http://your-proxy:port
export HTTPS_PROXY=http://your-proxy:port
py -m playwright install chromium
```

**4. Antivirus blocking the download**

Some antivirus (especially Windows Defender) blocks the Chromium
download. Try:
- Temporarily disable AV
- Re-run `py -m playwright install chromium`
- Re-enable AV

**5. Permission denied**

If you get permission errors, run as administrator:
- Right-click cmd → "Run as administrator"
- `cd` to the package directory
- Run `setup.bat`

Or install to user space:
```bash
py -m pip install --user playwright playwright-stealth
py -m playwright install chromium
```

### Hydration mismatch from password-manager extension

If you see a console warning about `data-protonpass-form` or similar
attributes, that's caused by a browser extension (ProtonPass, LastPass,
Bitwarden). It's not a real bug — the dashboard has `suppressHydrationWarning`
on the affected elements. Ignore it, or disable the extension on
localhost:3000.

### Script says "Not logged in" even after manual login

The script checks `<shreddit-app user-logged-in="true">` to detect login.
If Reddit changes that attribute name, the script falls back to extracting
the username from `<achievements-entrypoint username="...">` or
`<after-login-toast-dispatcher username="...">`. If none of those exist,
it falls back to `/api/v1/me`. If all three fail, use `--force-login` to
skip the check.

### Dashboard shows "No CSVs found"

Edit `dashboard/src/app/api/csv-list/route.ts` and change `ALLOWED_ROOT`
to the directory containing your CSV files.

### Script never finds the Join button

The script waits up to 15 seconds for the
`<shreddit-subreddit-header-buttons>` Web Component to hydrate. On slow
connections this might not be enough — try increasing the
`PAGE_LOAD_WAIT_MAX` constant at the top of `reddit_browser_subscriber.py`.

## Verifying against the real Reddit HTML

The selectors in `reddit_browser_subscriber.py` have been verified against
real authenticated sh.reddit.com HTML. Key elements we target:

| Element | Attributes we use |
|---|---|
| `<shreddit-app>` | `user-logged-in="true"` (definitive login check) |
| `<achievements-entrypoint>` | `username="..."` (extract the logged-in username) |
| `<after-login-toast-dispatcher>` | `username="..."` (fallback for username) |
| `<shreddit-subreddit-header-buttons>` | `name="..."`, `subreddit-id="t5_..."`, `is-user-logged-in` (the Join button container) |
| `<shreddit-subreddit-header>` | `description="..."`, `weekly-active-users="..."` (for scraping) |
| `<faceplate-timeago>` inside `<shreddit-subreddit-header>` | `ts="..."` (creation timestamp) |

The Join button itself isn't in the server-rendered HTML — it's rendered
inside the `<shreddit-subreddit-header-buttons>` Web Component's shadow
DOM after the component hydrates. The script's selectors handle both the
"Join" (not yet subscribed) and "Joined" (already subscribed) states.

## Legal / ToS note

Using Playwright to drive your own logged-in browser session is **not**
against Reddit's Terms of Service. The script does exactly what you would
do by hand — visit each subreddit page and click Join. It does not
scrape content for AI training, manipulate votes, spam, or access other
users' data.

However, mass-subscribing is a flagged pattern. Use a burner account,
let it warm up 24 hours before running, and don't push the pacing limits.
If you get shadowbanned, there's no appeal for burner accounts — switch
to a new one and re-run with `--reprocess-failed`.
