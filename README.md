# Reddit Mass Subreddit Subscriber — Browser Automation Edition

A Python script that subscribes a Reddit account to every subreddit listed in a
CSV file by **driving a real Chromium browser** via Playwright. No Reddit API
approval needed — the script does exactly what a human would do: navigate to
the subreddit page, find the Join button, click it, wait, move on.

Plus a **Next.js dashboard** (`/home/z/my-project/src/app/page.tsx`) that
watches the CSV file and shows live subscription status, scraped metadata
(members, description, NSFW flag), and verification results in a searchable,
filterable table. Auto-refreshes every 5 seconds.

> Designed for a fresh / burner account. Don't run this against your main account.

---

## 1. What's in this package

This package contains two pieces that work together:

1. **`reddit_browser_subscriber.py`** — the Python script that subscribes to
   subreddits via Playwright. Writes per-row status to the CSV in-place.
2. **Dashboard UI** — a Next.js app at the project root (`/src/app/page.tsx`)
   that reads the CSV every 5 seconds and shows live status. Auto-refreshes.

Run them in separate terminals:

```bash
# Terminal 1: run the subscriber script
python reddit_browser_subscriber.py --csv subreddits.csv

# Terminal 2: view the dashboard
bun run dev  # opens at http://localhost:3000
```

As the script processes each subreddit, the dashboard updates automatically
within ~5 seconds. No need to refresh the page.

---

## 2. Why this approach (and not the Reddit API)

Reddit rolled out the **Responsible Builder Policy** in October 2025. As of
that change, **you cannot create a new API app at `reddit.com/prefs/apps`
without first submitting a developer registration form and being approved by
Reddit staff.** The approval queue takes days to weeks, and there's no
"personal use" exception.

This script bypasses that gate entirely by using the web UI — the same UI
you'd use if you were subscribing by hand. No API credentials needed.

| Approach | Verdict |
|---|---|
| Reddit API via PRAW | ✅ robust, fast — but requires Responsible Builder Policy approval (days to weeks) |
| Raw HTTP to Reddit web endpoints | ❌ Anti-bot defenses block you within minutes |
| **Browser automation via Playwright (this script)** | ✅ No approval needed, behaves like a real user, has anti-shadowban pacing built in |

### Trade-offs (be honest about them)

- **Slower than the API**: ~15-25 seconds per subreddit (vs. <1s with API),
  because we're loading real pages and waiting for them to render.
- **Higher shadowban risk if you push it**: defaults are conservative
  (100 subs per session, 8-30s between rows, batch breaks every 25 subs).
  Don't crank these up.
- **Brittle to UI changes**: if Reddit changes the Join button's HTML,
  the selectors will need updating. For a couple-of-days use case, this is fine.
- **No headless mode by default**: headless browsers are easier for Reddit to
  fingerprint. Default is headful (a real visible window).

---

## 3. Quick start

### Prerequisites

- Python 3.9+
- ~500MB free disk space (Chromium download + browser profile)
- A burner Reddit account (see §3 if you don't have one)
- Your CSV of subreddits (any column with subreddit names works)

### Install

```bash
cd reddit_subscriber
pip install -r requirements.txt
python -m playwright install chromium
```

This installs Playwright, playwright-stealth, and downloads the Chromium
browser binary (~150MB).

### Run

```bash
# First run — opens a browser window, you log in manually, press Enter
python reddit_browser_subscriber.py --csv subreddits.csv
```

The script will:
1. Open a Chromium window (visible, not headless).
2. Navigate to `https://www.reddit.com/`.
3. Detect you're not logged in.
4. Print instructions in the terminal and wait for you to log in **by hand**
   in the browser window.
5. After you press Enter, it starts subscribing.
6. After each row, it writes the status back to the CSV in-place.
7. After all rows are done, it runs a verification pass.

Subsequent runs re-use the saved browser profile — no need to log in again
unless the cookies expire (typically 1-2 weeks).

---

## 4. Reddit-side setup

### 3.1 Create a burner Reddit account

1. Open <https://www.reddit.com> in a private / incognito window.
2. Click **Sign Up** in the top-right corner.
3. Use a throwaway email (ProtonMail, SimpleLogin, etc.). **Strongly
   recommended** — accounts without verified emails get stricter rate limits.
4. Click the verification link in the email before continuing.
5. Pick a username and password:
   - Username: case-sensitive, you'll type it the same way every time.
   - Password: avoid shell-special characters (`$`, `` ` ``, `\`, `"`, `!`).
6. Complete signup. Pick any "starter" subreddits if prompted — doesn't matter.

### 3.2 Let the account "warm up" (recommended for large lists)

Brand-new accounts that immediately hammer the site are sometimes flagged by
Reddit's anti-bot heuristics. Symptoms: sudden shadowbans, silent 403s, or
"prove your humanity" CAPTCHA walls.

- For lists <200 subs: you can probably skip this.
- For lists >1000 subs: let the account sit **~24 hours** after creation
  before running the script.

During warm-up: don't post, don't comment, don't subscribe to anything.
Just let the account exist.

### 3.3 Disable 2FA on the burner (optional but easier)

The script doesn't programmatically log you in — you do it by hand in the
browser window. So 2FA isn't a blocker; you can just complete the 2FA prompt
yourself when prompted. But if you want a smoother flow, disable 2FA
temporarily:

1. Go to <https://www.reddit.com/settings/privacy>.
2. Find "Two-factor authentication" and turn it OFF.
3. Run the script.
4. After the run, re-enable 2FA.

---

## 5. Usage

### Full run (subscribe + verify)

```bash
python reddit_browser_subscriber.py --csv subreddits.csv
```

### Re-run after a crash or Ctrl+C

The script is **resume-safe**. Just re-run the same command:

```bash
python reddit_browser_subscriber.py --csv subreddits.csv
```

Rows already marked `subscribed` or `already_subscribed` are skipped. Rows
marked `banned` / `not_found` / `private` / `quarantined` are also skipped
(these are properties of the subreddit, not your account).

### Verify-only (re-check the CSV against your live subscriptions)

```bash
python reddit_browser_subscriber.py --csv subreddits.csv --verify-only
```

### Retry rows that previously failed

```bash
python reddit_browser_subscriber.py --csv subreddits.csv --reprocess-failed
```

This resets rows marked `failed` back to `pending` and retries them.

### Increase the session cap (risky)

By default, the script stops after 100 subscribes in one session. This is a
deliberate safety limit to avoid shadowbans. If you want to override it:

```bash
python reddit_browser_subscriber.py --csv subreddits.csv --max-subscribes 200
```

**Not recommended** — going above 150-200 in a single session significantly
increases shadowban risk. Better to re-run the next day for the next batch.

### Run headless (NOT recommended)

```bash
python reddit_browser_subscriber.py --csv subreddits.csv --headless
```

Headless browsers are easier for Reddit to fingerprint (different rendering
behavior, missing GPU info, etc.). Only use this if you physically cannot
have a visible window open. Higher shadowban risk.

### All options

```
--csv CSV                   Path to the CSV of subreddits.
--profile-dir DIR           Browser profile dir (default: ~/.reddit_subscriber_profile).
                            Stores cookies so you only log in once.
--headless                  Run browser headless (NOT recommended).
--verify-only               Only run the verification pass.
--subscribe-only            Only run the subscribe pass (skip verification).
--reprocess-failed          Reset 'failed' rows back to 'pending' and retry.
--max-subscribes N          Hard cap on subscribes per session (default: 100).
--force-login               Force the manual login prompt even if logged in.
--verbose                   Enable debug logging.
```

---

## 6. CSV format

### Input

Any CSV with a column containing subreddit names. The script auto-detects the
column by checking for these header names (in order):

`subreddit` → `subreddit_name` → `sub` → `name` → `sr`

If no header is present, the first column is used.

Subreddit names can be in any of these forms (the script normalizes them):
- `AskReddit`
- `r/AskReddit`
- `/r/AskReddit`

### IMPORTANT: Non-destructive status tracking

**The input CSV is NEVER modified.** The script reads it once at startup
and writes all status updates to a SEPARATE status file at
`<input>.status.csv` (in the same directory).

For example, if your input is `subreddits.csv`, the status file is
`subreddits.status.csv`. This means:
- Your original input list stays pristine — you can re-use it on other
  accounts, share it, or version-control it.
- The status file is what the dashboard reads. If you delete it, the
  next run starts fresh (re-initializing from the input).
- You can override the status file path with `--status-csv`:
  ```bash
  python reddit_browser_subscriber.py --csv subreddits.csv \
      --status-csv /path/to/custom_status.csv
  ```

### Output (in the status file, not the input)

The status file gets these ADDED columns (preserving any existing ones
from the input):

| Column | Meaning |
|---|---|
| `status` | One of: `pending`, `subscribed`, `already_subscribed`, `failed`, `banned`, `not_found`, `private`, `quarantined`, `shadowbanned`, `aborted` |
| `error` | Error message if any (empty on success) |
| `subscribed_at` | ISO-8601 UTC timestamp of successful subscription |
| `verified` | `verified` / `unverified` / (empty if not yet checked) |
| `verified_at` | ISO-8601 UTC timestamp of last verification |
| `members` | Scraped subscriber count (best-effort, may be empty) |
| `description` | Scraped subreddit description (best-effort) |
| `created_utc` | Scraped subreddit creation timestamp (epoch float) |
| `is_nsfw` | Scraped NSFW flag (`true` / `false` / empty) |
| `icon_url` | Scraped subreddit icon URL (best-effort) |

The scraped metadata columns are populated **during the subscribe pass** —
the script extracts them from the page's inline JSON while it's already on
the subreddit page. No extra requests are made. If scraping fails (page
loaded but JSON wasn't where expected), the columns stay empty — this never
blocks subscription.

A run log is also written next to the CSV as `<csv-name>.log`.

### Status meanings

| Status | Meaning | Retryable? |
|---|---|---|
| `pending` | Not yet processed | Yes |
| `subscribed` | Successfully subscribed this run | Skip on re-run |
| `already_subscribed` | Was already subscribed before this run | Skip on re-run |
| `failed` | Could not subscribe (network error, button not found, etc.) | Yes — use `--reprocess-failed` |
| `not_found` | Subreddit doesn't exist (404) | No |
| `banned` | Subreddit is banned by Reddit | No |
| `private` | Subreddit is private (invite-only) | No |
| `quarantined` | Subreddit is quarantined — requires opt-in via web UI | No (unless you opt in first) |
| `shadowbanned` | Your account got shadowbanned mid-run | Yes — use `--reprocess-failed` with a NEW account |
| `aborted` | Session ended early (hit subscribe cap, manual abort, etc.) | Yes |

### Continue-on-error guarantee

The script **never aborts** on a per-row error. If `subscribe_one` raises
an unexpected exception (browser crash, network timeout, page error,
anything), it is caught, the row is marked `failed` with the error
message, and the loop continues to the next row. Only two things abort
the run early:

1. **Shadowban detected** (pre-flight or mid-run after 5 consecutive failures)
2. **Session cap reached** (`--max-subscribes` exceeded)

Everything else keeps going. This is the critical behavior for processing
large CSVs unattended.

---

## 7. How it works

### Pipeline

```
[CSV]
  │
  ├─ BrowserSession.start()
  │   launch_persistent_context(profile_dir)
  │   apply playwright-stealth evasions
  │
  ├─ ensure_logged_in()
  │   goto reddit.com
  │   detect username via DOM / fetch /api/v1/me
  │   if not logged in:
  │       print "log in by hand in the browser window, press Enter"
  │       wait for input()
  │
  ├─ run_subscribe_pass()
  │   pre-flight shadowban check (fetch /user/{me}/about/.json)
  │   if shadowbanned: abort, mark all pending as 'shadowbanned'
  │   for each row:
  │       skip if DONE (subscribed/already_subscribed)
  │       skip if TERMINAL (banned/not_found/private/quarantined)
  │       if 5 consecutive failures: re-check shadowban
  │       goto https://sh.reddit.com/r/{name}
  │       wait for shreddit-subreddit-header-buttons to render
  │       check if Joined button present → already_subscribed
  │       else find Join button, hover, click
  │       wait for button text to change to "Joined"
  │       write CSV row with status
  │       sleep 8-30s with jitter
  │       every 25 subs: take a 60-120s break
  │       stop at 100 subs (hard cap)
  │
  ├─ run_verify_pass()
  │   fetch https://www.reddit.com/subreddits/mine/.json (paginated)
  │   for each row:
  │       if name in live set → verified
  │       else → unverified
  │   log WARNING for rows claiming subscribed but not in live set
  │
  └─ close (cookies persist to profile_dir for next run)
```

### Anti-shadowban pacing

The script uses random delays throughout to mimic a careful human:

| Phase | Delay range (seconds) | Why |
|---|---|---|
| Page load wait | 4-8 | Let everything render before interacting |
| Pre-click hover | 2-6 | Mouse movement before clicking |
| Post-click wait | 3-8 | Let network settle after the API call |
| Inter-row delay | 8-30 | Reading time between subreddits |
| Batch break (every 25 subs) | 60-120 | Stretch / coffee break |

Plus:
- **Mouse movements are stepped** (10-20 small movements to the target, not a
  teleport) — Playwright's `mouse.move(x, y, steps=N)`.
- **Headful by default** — a real visible window, not a headless browser.
- **Real persistent profile** — cookies and localStorage stay across runs,
  so the session looks "lived in" to Reddit.
- **100-subscribe hard cap per session** — aborts cleanly after this.
  Re-run the next day for the next batch.
- **playwright-stealth** evasions applied (navigator.webdriver hidden, etc.).

### Shadowban detection

Two layers:

1. **Pre-flight check** before any subscribes: fetches
   `https://www.reddit.com/user/{me}/about/.json` with the session cookies.
   If the response is 404 or `{"reason": "THING_NOT_FOUND"}`, the account is
   shadowbanned — abort the entire run, mark all pending rows as
   `shadowbanned`.

2. **Mid-run re-check**: if 5 consecutive subscribes fail (button click didn't
   change state, etc.), re-check shadowban status. If shadowbanned, abort.
   Otherwise, reset the failure counter and continue.

### Selectors used

Reddit's modern UI (sh.reddit.com) uses Web Components. The Join button is
rendered by the `<shreddit-subreddit-header-buttons>` custom element. The
script tries multiple fallback selectors in priority order:

1. `shreddit-subreddit-header-buttons button[aria-label*="Join" i]`
2. `shreddit-subreddit-header-buttons button:has-text("Join")`
3. `button[data-testid="subscribe-button"]` (new reddit)
4. `button[aria-label*="join" i]:not([aria-label*="joined" i])` (new reddit)
5. `a.fancy-toggle-button.add` (old reddit)
6. `.subbutton` (very old reddit)
7. `button:has-text("Join")` (generic fallback)

If you ever need to debug selector failures, run with `--verbose` and check
the log file — the script logs which selector it tried and what it found.

---

## 8. Rate limit expectations

Reddit's web UI doesn't enforce the strict 60-req/min OAuth limit, but it
does have anti-bot rate limiting that kicks in if you go too fast.

| CSV size | Approx. wall-clock time |
|---|---|
| 50 subreddits | ~15 minutes |
| 100 subreddits (one session) | ~30 minutes |
| 500 subreddits | 5 sessions of ~30 min each, across 5 days |
| 5,000 subreddits | ~50 sessions across ~50 days |

The 100-sub/session cap is a hard limit. To go faster, you'd need to either:

- Run multiple accounts in parallel (each with its own browser profile)
- Use the Reddit API instead (requires Responsible Builder Policy approval)

---

## 9. Re-running safely

The script is **resume-safe**. If you Ctrl+C it, kill it, or it crashes:

```bash
# Just re-run the same command
python reddit_browser_subscriber.py --csv subreddits.csv
```

- Rows marked `subscribed` or `already_subscribed` are skipped.
- Rows marked `banned` / `not_found` / `private` / `quarantined` are skipped.
- Rows marked `failed` are skipped — use `--reprocess-failed` to retry them.
- Rows still `pending` are processed normally.
- Rows marked `shadowbanned` (from a previous run that aborted) need a new
  account. Create one, then re-run with the same CSV — those rows will be
  retried as `pending` if the new account isn't shadowbanned.

Wait — actually, `shadowbanned` rows are NOT auto-reset. To retry them on a
new account, manually change them to `pending` in the CSV, or run:

```bash
# Reset shadowbanned rows back to pending (one-liner using csvkit or awk)
# Or just open the CSV in a spreadsheet and find-replace.
```

---

## 10. Verification guarantees

After the subscribe pass, the script fetches
`https://www.reddit.com/subreddits/mine/.json` (paginated, up to 100 pages of
200 subs each = 20,000 subs max). This is the same endpoint the Reddit web UI
uses to populate your "My Communities" list.

- Each row's `verified` column is set to `verified` or `unverified`.
- Any row whose `status` claims `subscribed` but isn't in the live set is
  logged as a WARNING with the subreddit name. This catches edge cases like
  Reddit silently failing to apply a subscription.

To re-verify without re-subscribing:

```bash
python reddit_browser_subscriber.py --csv subreddits.csv --verify-only
```

---

## 11. Troubleshooting

### Browser / Playwright errors

**`playwright._impl._errors.Error: Browser chromium launch failed`**
→ You haven't installed the Chromium binary. Run:
  `python -m playwright install chromium`

**`playwright._impl._errors.Error: Executable doesn't exist at ...`**
→ Same as above. The Chromium binary is missing.

**`playwright_stealth` import error**
→ Install it: `pip install playwright-stealth`. The script works without it
  (logs a warning) but you'll have less anti-detection coverage.

**Browser window doesn't appear / appears but is blank**
→ Make sure you're not running with `--headless`. If running over SSH
  without X11 forwarding, headful mode won't work — use `--headless` (but
  accept the higher shadowban risk), or run on a real desktop.

### Login issues

**"Not logged in" even though I logged in in the browser**
→ The script's username-detection logic checks 3 places: the user menu
  button's aria-label, inline `<script>` data, and `/api/v1/me`. If all
  three fail (rare), it'll keep saying "not logged in" even though you are.
  Fix: use `--force-login` to skip the check, or wait 30 seconds after
  login for cookies to settle, then close the script and re-run.

**Cookies don't persist across runs**
→ Make sure you're not deleting the `--profile-dir` between runs. Default
  is `~/.reddit_subscriber_profile`. If you `rm -rf` it, you'll need to
  log in again.

**"Press Enter when you're logged in..." but I'm running over SSH**
→ The script needs an interactive terminal for the `input()` call. Run it
  in a real terminal, not piped from another process. Alternatively,
  pre-login by visiting reddit.com manually in a Chrome window that uses
  the same `--profile-dir`.

### Subscription errors

**`status=failed: "could not find Join button on page"`**
→ Reddit's UI may have changed, or the page didn't fully render. Try
  re-running with `--reprocess-failed`. If it persists, run with `--verbose`
  and check the log file — the script logs the page body sample, which will
  show what's actually on the page.

**`status=failed: "Join button clicked but state did not change to Joined"`**
→ The click registered but Reddit didn't accept the subscription. Common
  causes: rate-limited, shadowbanned (check pre-flight), or the subreddit
  has unusual state. Re-run with `--reprocess-failed`. If 5+ rows fail in
  a row, the script will automatically re-check shadowban status.

**`status=not_found`**
→ The subreddit is deleted, never existed, or was renamed. Check spelling.

**`status=banned`**
→ The subreddit itself is banned by Reddit. Nothing you can do.

**`status=private`**
→ The subreddit is private and you're not on the approved-user list.

**`status=quarantined`**
→ The subreddit is quarantined. You'd need to opt in via the web UI first
  (<https://www.reddit.com/r/SUB/about/quarantine>), then re-run with
  `--reprocess-failed` for those rows.

**`status=shadowbanned`**
→ Your account got shadowbanned. This is the worst case. You'll need to
  create a new burner account (let it warm up 24 hours — see §3.2),
  manually change `shadowbanned` rows back to `pending` in the CSV, and
  re-run with the new account.

  Reddit does not notify you when you're shadowbanned. Symptoms include:
  your posts/comments get zero engagement (visible only to you), your
  profile page returns 404 to logged-out users, and subscribe / vote
  actions silently fail. You can check at <https://www.reddit.com/r/ShadowBan>
  or use the script's built-in `check_shadowban` function.

### Verification errors

**`Verification: 0 verified, N unverified`**
→ Either you're not actually logged in (re-login with `--force-login`), or
  the `/subreddits/mine/.json` endpoint returned an error. Check the log
  file for HTTP status codes.

**`WARNING: N row(s) claim subscribed but are NOT in live subscription set`**
→ The subscribe click succeeded, but Reddit silently rejected the
  subscription. Common with shadowbanned accounts. Re-check shadowban
  status (the script does this pre-flight, but it can happen mid-run too).

### Performance / pacing

**Script is slow**
→ It's supposed to be. The defaults (8-30s between rows, 60-120s breaks
  every 25 subs, 100-sub session cap) are designed to mimic a careful
  human. Going faster dramatically increases shadowban risk.

**Want to go faster?**
→ Don't. But if you must:
  - Increase `--max-subscribes` to 150-200 (still risky)
  - Edit the constants at the top of the script (INTER_ROW_DELAY_MIN/MAX,
    BATCH_BREAK_EVERY_N) — but if you set them too low, you WILL get
    shadowbanned.
  - Run multiple accounts in parallel (each with its own `--profile-dir`).

---

## 12. Dashboard UI

The package includes a Next.js dashboard at the project root that watches
the status CSV in real time.

### Starting the dashboard

```bash
# From the project root (where package.json lives)
bun run dev
```

The dashboard opens at <http://localhost:3000>. (In the sandbox preview,
use the URL shown by the preview panel — don't navigate to localhost
manually.)

### Dark mode

The dashboard defaults to **dark mode** for reduced eye strain during
long-running subscription sessions. This is set at the layout level
(`<html className="dark">`) so it applies to every page.

### What it shows

- **4 stat cards**: Subscribed, Pending, Failed, Terminal — each with count,
  percentage, and a mini progress bar.
- **Overall progress bar**: stacked bar showing the breakdown of all rows
  by status category.
- **Status legend**: chips for each status present in the CSV, with counts.
- **Searchable, filterable table** of subreddits. Each row shows:
  - Subreddit name (with icon if scraped)
  - Status badge (color-coded)
  - Member count (formatted as K/M)
  - Description (line-clamped)
  - Creation date
  - Subscribed-at timestamp
  - Verified indicator (green check or red X)
  - Error message (with hover tooltip for full text)
- **Filters**: search by name, filter by status category (Subscribed /
  Pending / Failed / Terminal), filter by NSFW (SFW / NSFW / All).
- **CSV selector**: dropdown to switch between multiple CSV files in the
  `reddit_subscriber` directory. **Status files (`.status.csv`) are
  preferred** — if both `subs.csv` and `subs.status.csv` exist, only the
  status file appears in the dropdown (with a green "STATUS" badge).
- **Auto-refresh toggle**: polls `/api/csv-data` every 5 seconds.

### How it reads the CSV

The dashboard has two API routes:

- `GET /api/csv-list` — lists all `.csv` files in the
  `reddit_subscriber` directory. Status files are sorted first and labeled
  with a STATUS badge. If both `subs.csv` and `subs.status.csv` exist,
  only the status file is shown (the bare input file is hidden).
- `GET /api/csv-data?csv=NAME` — reads the named CSV, parses it (handling
  quoted fields, auto-detecting headers), and returns JSON.

The CSV path is sandboxed: only files inside
`/home/z/my-project/download/reddit_subscriber/` can be read. The API
rejects anything outside that directory with a 403.

### Live updates

While the Python script runs, it writes the status CSV atomically after
every row. The dashboard polls every 5 seconds and picks up the changes
automatically — no need to refresh the page.

To watch the script work in real time:

```bash
# Terminal 1: bun run dev (dashboard running)
# Terminal 2: python reddit_browser_subscriber.py --csv subreddits.csv
```

Open the dashboard in your browser — you'll see each row flip from
`pending` → `subscribed` (or `failed` / `banned` / etc.) as the script
processes it. The input CSV (`subreddits.csv`) is never touched; all
updates go to `subreddits.status.csv`.

### Hydration errors from password-manager extensions

If you see a console warning like:

```
A tree hydrated but some attributes of the server rendered HTML didn't
match the client properties.
```

with a diff showing attributes like `data-protonpass-form`, that's caused
by a browser extension (ProtonPass, LastPass, Bitwarden, etc.) modifying
the DOM after server render but before React hydrates. It's not a real
bug — the script suppresses these warnings on the affected elements.
You can safely ignore them. If they bother you, disable the extension
on this domain, or use a private/incognito window without extensions.

---

## 13. Files

```
reddit_subscriber/
├── reddit_browser_subscriber.py   # the script
├── requirements.txt                # playwright, playwright-stealth
├── README.md                       # this file
└── subreddits_sample.csv           # example input (with sample statuses for testing the dashboard)

# Dashboard (at project root):
src/app/page.tsx                    # dashboard UI
src/app/api/csv-data/route.ts       # API: read CSV as JSON
src/app/api/csv-list/route.ts       # API: list available CSVs
```

The script also creates:
- `~/.reddit_subscriber_profile/` — persistent browser profile (cookies,
  localStorage). Keep this between runs. Delete it to force re-login.
- `<csv-name>.log` — run log, written next to the CSV.

---

## 14. Legal / ToS note

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

## 15. Migration from the PRAW version

If you used the previous PRAW-based version of this script (in
`reddit_subscriber.py`), your CSV is compatible — both scripts use the same
column names. Just run:

```bash
python reddit_browser_subscriber.py --csv subreddits.csv
```

Rows already marked `subscribed` by the PRAW version will be skipped. Rows
marked `failed` (which may have been due to API limits, not Reddit-side
issues) should be retried with `--reprocess-failed` since the browser
flow doesn't have the same rate-limit constraints.

The only difference: the `shadowbanned` status is new to the browser
version. It indicates the account was shadowbanned mid-run; you'll need
to switch to a new account and reset those rows manually.

---

## 14. GitHub auto-update (in-app polling)

This package can automatically pull updates from GitHub while the dashboard is
running — **no systemd, no cron, no separate service**. The Next.js app itself
polls GitHub every 60 seconds and applies updates via `git pull`.

### One-time setup

1. **Create a private GitHub repo** at <https://github.com/new>
   - Name: e.g. `reddit-subscriber`
   - Set to **Private** (recommended)
   - Do NOT initialize with README/license/.gitignore (this folder already has them)

2. **Create a Personal Access Token (PAT)** at <https://github.com/settings/tokens>:
   - Click "Generate new token (classic)"
   - Scopes: check **`repo`** (full control of private repos)
   - Set an expiration (90 days is fine)
   - Copy the token (`ghp_xxxxxxxxx...`) — you'll paste it into the dashboard

3. **Initialize git on your dev machine** (where you'll make changes):
   ```bash
   cd reddit_subscriber_package
   ./setup-git.sh https://github.com/YOUR_USERNAME/reddit-subscriber.git
   ```
   This initializes the repo, makes the first commit, and pushes to GitHub.

4. **On the Pi, clone the repo once**:
   ```bash
   cd ~
   git clone https://github.com/YOUR_USERNAME/reddit-subscriber.git reddit_subscriber_package
   cd reddit_subscriber_package
   ./start.sh
   ```

5. **In the dashboard UI, open Settings (gear icon)**:
   - Scroll down to **GitHub Auto-Update**
   - Paste your repo URL: `https://github.com/YOUR_USERNAME/reddit-subscriber.git`
   - Paste your PAT
   - Toggle "Auto-pull every 60 seconds" ON
   - Click **Save**

That's it. Now whenever the dashboard is running, it polls GitHub every 60s
and auto-applies new commits.

### How it works

| What changes | What happens |
|---|---|
| Dashboard frontend (TSX/CSS) | Next.js HMR hot-reloads the page automatically |
| `next.config.ts` or `package.json` | Notification shown — restart `start.sh` to apply |
| `reddit_browser_subscriber.py` | Pulled to disk; the **next** Start uses the new code (running process keeps old code in memory) |
| `requirements.txt` | `pip install -r requirements.txt` runs automatically |
| `dashboard/package.json` deps | `npm install` runs automatically |

When an update is pulled, a blue banner appears at the top of the dashboard
showing what changed. The settings panel also shows the current HEAD commit,
last check time, and recent commit messages.

### Day-to-day workflow

**On the dev machine (or via AI assistant):**
```bash
./sync.sh                       # commit + push
./sync.sh "fixed scroll bug"    # commit with message + push
```

The `sync.sh` script reads the PAT from `dashboard/.config.json` automatically,
so you don't need to type credentials every time. (If no PAT is stored there,
it falls back to git's default credential helper.)

**On the Pi:**
- Nothing! The running dashboard picks up the changes within 60 seconds.
- If the dashboard isn't running, the next `./start.sh` will pull latest
  automatically (git fetches on startup if `autoUpdate` is enabled).

### Manual controls

In the dashboard Settings panel:
- **"Check now"** button — manually trigger a fetch + pull
- **Auto-pull toggle** — turn polling on/off without losing the saved PAT
- **Status display** — shows current HEAD, last check, recent commits

### Giving the AI assistant push access

To let me (the AI) push updates directly to your repo:

1. Make sure you've completed the one-time setup above (repo created, PAT generated)
2. In our chat, paste:
   - The repo URL (e.g. `https://github.com/YOUR_USERNAME/reddit-subscriber.git`)
   - The PAT (`ghp_xxxxxxxxx...`)
3. I'll configure git credentials in my environment, clone the repo, make changes, and push
4. The Pi auto-pulls within 60 seconds

The PAT is stored only in my session memory for the duration of our conversation.
For a fresh session, you'd need to paste it again.

### Troubleshooting

- **"Could not fetch from remote"** in the dashboard: check that the repo URL
  is correct and the PAT has `repo` scope.
- **Auto-update not firing**: confirm the toggle is ON in Settings and the
  dashboard process is running (the polling happens client-side via React's
  `useEffect`, so the page needs to be open in a browser somewhere — but the
  Pi's own browser can have it open in a background tab).
- **`git pull` failed**: check `/api/auto-update`'s response in the browser
  dev tools. Common causes: PAT expired, repo URL wrong, network blocked.
- **Want to disable auto-update?** Toggle it off in Settings. The PAT stays
  stored so you can re-enable it later.
