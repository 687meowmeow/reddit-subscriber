#!/usr/bin/env python3
"""
Reddit Mass Subreddit Subscriber — Browser Automation Edition
=============================================================

Automates subscribing to a list of subreddits from a CSV file by driving
a real Chromium browser via Playwright. No Reddit API approval needed —
this script does exactly what a human would do: navigate to the
subreddit page, find the Join button, click it, wait, move on.

Why browser automation instead of the Reddit API?
-------------------------------------------------
Reddit's Responsible Builder Policy (Oct 2025) requires pre-approval
for any new API app, and the approval queue takes days to weeks. This
script bypasses that entirely by using the web UI — same as a human.

Features (parity with the PRAW version)
---------------------------------------
- Per-row status tracking written to CSV in-place, atomically, after
  every single row.
- Resume safety: already-subscribed rows are skipped on re-runs.
- Verification pass: pulls the account's actual subscribed-subreddit
  list (via /subreddits/mine/.json with the session cookies) and marks
  each CSV row verified/unverified.
- Anti-shadowban pacing: random delays, human-like mouse movements,
  batch breaks, hard cap on subscribes per session.
- Built-in shadowban detection: pre-flight check + mid-run re-check
  if 5 consecutive subscribes fail. Aborts cleanly if shadowbanned.
- Persistent browser profile: log in once, re-use the session across
  runs. Cookies stay valid for days.
- Manual login flow: the script never types your password. You log in
  by hand in the browser window it opens, then press Enter.

CSV format
----------
Any CSV with a column of subreddit names. The script READS this file
once at startup; it is NEVER modified.

Instead, the script writes per-row status updates to a SEPARATE status
file at `<input>.status.csv` (in the same directory). You can override
this with --status-csv.

The status file gets these ADDED columns (preserving any existing ones
from the input):

    status        - pending | subscribed | already_subscribed
                    | failed | not_found | private | quarantined
                    | shadowbanned | aborted
    error         - error message (empty on success)
    subscribed_at - ISO-8601 UTC timestamp of successful subscription
    verified      - verified | unverified | (empty if not yet checked)
    verified_at   - ISO-8601 UTC timestamp of last verification
    members       - scraped subscriber count (best-effort)
    description   - scraped subreddit description (best-effort)
    created_utc   - scraped subreddit creation timestamp
    is_nsfw       - scraped NSFW flag (true/false)
    icon_url      - scraped subreddit icon URL

Usage
-----
    # First run: opens a browser window, you log in manually, then
    # press Enter in the terminal to begin subscribing.
    python reddit_browser_subscriber.py --csv subreddits.csv
    # Status is written to: subreddits.status.csv (input is untouched)

    # Re-run (cookies are saved — no need to log in again)
    python reddit_browser_subscriber.py --csv subreddits.csv

    # Use a custom status file path
    python reddit_browser_subscriber.py --csv subreddits.csv \\
        --status-csv /path/to/my_status.csv

    # Verify-only (re-check the CSV against your live subscriptions)
    python reddit_browser_subscriber.py --csv subreddits.csv --verify-only

    # Retry rows that previously failed
    python reddit_browser_subscriber.py --csv subreddits.csv --reprocess-failed

    # Run headless (NOT recommended — higher shadowban risk)
    python reddit_browser_subscriber.py --csv subreddits.csv --headless
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import os
import random
import re
import socket
import sys
import tempfile
import time
import traceback
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.request import urlopen

# -------------------------------------------------------------------
# Constants
# -------------------------------------------------------------------

# Columns the script manages on top of the user's existing CSV schema.
STATUS_COL        = "status"
ERROR_COL         = "error"
SUBSCRIBED_AT_COL = "subscribed_at"
VERIFIED_COL      = "verified"
VERIFIED_AT_COL   = "verified_at"

# Scraped subreddit metadata columns (populated during the subscribe pass).
# These give the dashboard useful info without needing to re-visit each sub.
MEMBERS_COL       = "members"
DESCRIPTION_COL    = "description"
CREATED_COL       = "created_utc"
NSFW_COL          = "is_nsfw"
ICON_COL          = "icon_url"

SCRAPED_COLS: Tuple[str, ...] = (
    MEMBERS_COL, DESCRIPTION_COL, CREATED_COL, NSFW_COL, ICON_COL,
)

MANAGED_COLS: Tuple[str, ...] = (
    STATUS_COL, ERROR_COL, SUBSCRIBED_AT_COL, VERIFIED_COL, VERIFIED_AT_COL,
    *SCRAPED_COLS,
)

# Candidate header names for the subreddit column (checked in order).
DEFAULT_INPUT_COLS: Tuple[str, ...] = (
    "subreddit", "subreddit_name", "sub", "name", "sr",
)

# Statuses that mean "we already handled this row, don't redo work".
DONE_STATUSES: Set[str] = {"subscribed", "already_subscribed"}

# Statuses that are non-retryable (the subreddit itself is the problem).
TERMINAL_STATUSES: Set[str] = {
    "not_found", "banned", "private", "quarantined",
}

# Statuses that are retryable on a re-run (--reprocess-failed resets these).
# Includes 'shadowbanned' so the user can re-run with a new account without
# manually editing the CSV.
RETRYABLE_STATUSES: Set[str] = {"failed", "shadowbanned"}

# Anti-shadowban pacing parameters (seconds).
# Tuned to mimic a careful human reading the page before clicking.
PAGE_LOAD_WAIT_MIN     = 4.0
PAGE_LOAD_WAIT_MAX     = 8.0
PRE_CLICK_DELAY_MIN    = 2.0
PRE_CLICK_DELAY_MAX    = 6.0
POST_CLICK_WAIT_MIN    = 3.0
POST_CLICK_WAIT_MAX   = 8.0
INTER_ROW_DELAY_MIN    = 8.0
INTER_ROW_DELAY_MAX    = 30.0
BATCH_BREAK_EVERY_N    = 25
BATCH_BREAK_MIN        = 60.0
BATCH_BREAK_MAX        = 120.0
MAX_SUBSCRIBES_PER_SESSION = 100  # 8GB Pi can handle 100 per session

# Number of consecutive subscribe failures that triggers a shadowban re-check.
SHADOWBAN_CHECK_THRESHOLD = 5

# --- Resource management ---
# Restart the browser every N subscribes to release Chromium's leaked memory.
# Chromium is notoriously bad at releasing RAM — over thousands of page loads,
# it can consume all available memory on a Pi.
# With 8GB RAM, every 30 subscribes is reasonable.
BROWSER_RESTART_EVERY_N = 30

# Minimum available RAM (in MB) required to continue processing.
# If the Pi drops below this, we pause and wait for memory to be freed.
# Set to 200 MB — if we're actually running out of RAM, this will catch it.
MIN_AVAILABLE_RAM_MB = 200

# Maximum log file size (in MB) before rotation kicks in.
MAX_LOG_FILE_SIZE_MB = 50

# Subreddit URL pattern. sh.reddit.com is the modern UI; uses Web Components.
SUBREDDIT_URL_TEMPLATE = "https://sh.reddit.com/r/{name}/"
# JSON endpoint — works with session cookies, returns full metadata.
SUBREDDIT_JSON_URL_TEMPLATE = "https://www.reddit.com/r/{name}/about/.json"
VERIFY_URL_TEMPLATE    = "https://www.reddit.com/subreddits/mine/.json?limit=200"
ABOUT_URL_TEMPLATE     = "https://www.reddit.com/user/{name}/about/.json"

# Browser profile directory (relative to script location by default,
# or override with --profile-dir).
DEFAULT_PROFILE_DIR = Path.home() / ".reddit_subscriber_profile"

# Pause-flag file — when this file exists, the subscriber pauses processing
# (used by the auto-update system to safely apply GitHub updates mid-run).
# The path is passed via the PAUSE_FLAG_FILE environment variable.
PAUSE_FLAG_FILE = os.environ.get("PAUSE_FLAG_FILE", "")


# -------------------------------------------------------------------
# Internet connectivity check
# -------------------------------------------------------------------

def check_internet_connection(timeout: float = 5.0) -> bool:
    """
    Check if we have a working internet connection by trying to reach
    Reddit's servers. Returns True if reachable, False otherwise.
    """
    try:
        # Try to connect to Reddit's servers with a short timeout.
        # We use a raw socket connection to avoid HTTPS overhead.
        sock = socket.create_connection(("www.reddit.com", 443), timeout=timeout)
        sock.close()
        return True
    except (socket.timeout, OSError, ConnectionError):
        pass
    # Fallback: try Google's DNS (very reliable)
    try:
        sock = socket.create_connection(("8.8.8.8", 53), timeout=timeout)
        sock.close()
        return True
    except (socket.timeout, OSError, ConnectionError):
        return False


def wait_for_internet(check_interval: float = 30.0) -> None:
    """
    Block until an internet connection is available. Logs a message every
    check_interval seconds. Used at startup and mid-run if the connection drops.
    """
    if check_internet_connection():
        return
    log.warning("No internet connection detected. Waiting for connectivity...")
    while not check_internet_connection():
        log.info("  still offline — retrying in %.0fs...", check_interval)
        time.sleep(check_interval)
    log.info("Internet connection restored. Continuing.")


def wait_if_paused() -> None:
    """
    Check if the pause flag file exists. If so, sleep until it's removed.
    Called before processing each row so the auto-update system can safely
    apply updates without interrupting a subscription mid-click.
    """
    if not PAUSE_FLAG_FILE:
        return
    if not os.path.exists(PAUSE_FLAG_FILE):
        return
    log.info("Pause flag detected — waiting for update to complete...")
    while os.path.exists(PAUSE_FLAG_FILE):
        time.sleep(2.0)
    log.info("Pause flag removed — resuming.")


# -------------------------------------------------------------------
# Resource monitoring — protect the Pi from OOM kills
# -------------------------------------------------------------------

def get_available_ram_mb() -> float:
    """
    Read /proc/meminfo to get available RAM in MB.
    Returns 9999 on non-Linux platforms (so the check is skipped).
    """
    if not sys.platform.startswith("linux"):
        return 9999.0
    try:
        with open("/proc/meminfo", "r") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    # Format: "MemAvailable:  1234567 kB"
                    parts = line.split()
                    return int(parts[1]) / 1024.0
    except Exception:
        pass
    return 9999.0


def get_disk_free_mb(dir_path: str = ".") -> float:
    """
    Get free disk space in MB for the given directory.
    Returns 9999 on error.
    """
    try:
        stat = os.statvfs(dir_path)
        return (stat.f_bavail * stat.f_frsize) / (1024 * 1024)
    except Exception:
        return 9999.0


def check_system_resources(csv_path_str: str = ".") -> bool:
    """
    Check if the system has enough resources to continue.
    Returns True if OK to continue, False if we should pause.

    Checks:
    1. Available RAM — if below MIN_AVAILABLE_RAM_MB, pause and wait
    2. Free disk space — if below 500 MB, abort (can't write status CSV)

    This protects pi-hole, sshd, and other services from the OOM killer.
    """
    # Check disk space first — if we can't write, there's no point continuing
    disk_free = get_disk_free_mb(csv_path_str)
    if disk_free < 500:
        log.error("CRITICAL: Only %.0f MB disk space free at %s. "
                  "Aborting to prevent filesystem corruption.",
                  disk_free, csv_path_str)
        return False

    # Check RAM
    available = get_available_ram_mb()
    if available < MIN_AVAILABLE_RAM_MB:
        log.warning("LOW MEMORY: only %.0f MB RAM available (minimum: %d MB). "
                    "Pausing to protect system services (pi-hole, sshd).",
                    available, MIN_AVAILABLE_RAM_MB)
        # Wait for memory to be freed. Check every 30 seconds.
        while available < MIN_AVAILABLE_RAM_MB:
            log.info("  RAM: %.0f MB free — waiting 30s for memory to be freed...",
                     available)
            time.sleep(30)
            available = get_available_ram_mb()
        log.info("RAM recovered: %.0f MB available. Continuing.", available)

    return True


def kill_orphaned_chromium() -> int:
    """
    Kill ANY orphaned Chromium/chrome processes left over from previous runs.
    Returns the number of processes killed.

    This is called at startup, on exit, and during browser restarts to prevent
    zombie processes from accumulating and consuming RAM.

    Uses multiple search patterns to catch ALL Chromium variants:
    - chrome-linux-arm64/chrome (Playwright's Chromium)
    - chromium-browser (system Chromium)
    - headless_shell (Playwright headless mode)
    """
    killed = 0
    if not sys.platform.startswith("linux"):
        return killed
    try:
        import subprocess
        # Search patterns for all Chromium process variants
        patterns = [
            "chrome-linux-arm64/chrome",
            "chrome-linux/chrome",
            "chromium-browser",
            "chromium",
            "headless_shell",
            "chrome --type=",          # Chromium's child processes
        ]
        pids_killed = set()
        for pattern in patterns:
            try:
                result = subprocess.run(
                    ["pgrep", "-f", pattern],
                    capture_output=True, text=True, timeout=5
                )
                pids = result.stdout.strip().split("\n") if result.stdout.strip() else []
                for pid_str in pids:
                    pid_str = pid_str.strip()
                    if not pid_str:
                        continue
                    pid = int(pid_str)
                    if pid in pids_killed:
                        continue
                    if pid == os.getpid():
                        continue  # don't kill ourselves
                    try:
                        os.kill(pid, 9)  # SIGKILL
                        pids_killed.add(pid)
                        killed += 1
                    except (ProcessLookupError, ValueError, PermissionError):
                        pass
            except Exception:
                continue
        if killed > 0:
            log.info("Killed %d orphaned Chromium process(es).", killed)
    except Exception as exc:
        log.debug("kill_orphaned_chromium error: %s", exc)
    return killed


def rotate_log_if_needed(log_path: Path) -> None:
    """
    If the log file exceeds MAX_LOG_FILE_SIZE_MB, rotate it:
    rename to .1 and start a new file. Keeps only one backup.
    """
    try:
        size_mb = log_path.stat().st_size / (1024 * 1024)
        if size_mb > MAX_LOG_FILE_SIZE_MB:
            backup = log_path.with_suffix(log_path.suffix + ".1")
            if backup.exists():
                backup.unlink()
            log_path.rename(backup)
            log.info("Rotated log file (was %.1f MB). New log starts.", size_mb)
    except Exception as exc:
        log.debug("log rotation error: %s", exc)


def get_cpu_temp_c() -> float:
    """
    Read the Pi's CPU temperature.
    Returns 0 on non-Linux or if the file doesn't exist.
    High CPU temp (>80°C) causes thermal throttling and lockups.
    """
    if not sys.platform.startswith("linux"):
        return 0.0
    try:
        with open("/sys/class/thermal/thermal_zone0/temp", "r") as f:
            return int(f.read().strip()) / 1000.0
    except Exception:
        return 0.0


def get_load_average() -> tuple:
    """Return the 1/5/15 minute load average. Returns (0,0,0) on non-Linux."""
    if not sys.platform.startswith("linux"):
        return (0.0, 0.0, 0.0)
    try:
        return os.getloadavg()
    except Exception:
        return (0.0, 0.0, 0.0)


def get_open_file_descriptors() -> int:
    """
    Count the number of open file descriptors for this process.
    A leak here would eventually hit the ulimit and cause failures.
    """
    try:
        return len(os.listdir(f"/proc/self/fd"))
    except Exception:
        return 0


def log_system_health(context: str = "") -> None:
    """
    Log a comprehensive snapshot of system health.
    Call this periodically to diagnose what's actually causing the Pi
    to become unresponsive.

    Logs:
    - Available RAM (MB)
    - CPU temperature (°C) — thermal throttling causes lockups
    - Load average (1/5/15 min) — high load = CPU starvation
    - Open file descriptors — leak would hit ulimit
    - Disk free space (MB)
    - Number of chrome processes
    """
    ram = get_available_ram_mb()
    temp = get_cpu_temp_c()
    load1, load5, load15 = get_load_average()
    fds = get_open_file_descriptors()

    # Count chrome processes
    chrome_count = 0
    try:
        import subprocess
        result = subprocess.run(
            ["pgrep", "-c", "-f", "chrome"],
            capture_output=True, text=True, timeout=3
        )
        if result.stdout.strip():
            chrome_count = int(result.stdout.strip())
    except Exception:
        pass

    log.info(
        "[health] %s | RAM: %.0fMB | CPU: %.1f°C | Load: %.1f/%.1f/%.1f | "
        "FDs: %d | chrome procs: %d",
        context, ram, temp, load1, load5, load15, fds, chrome_count
    )

    # Warn on specific conditions
    if temp > 80:
        log.warning("[health] CPU temperature %.1f°C — Pi may be thermally throttling! "
                    "This causes system lockups.", temp)
    if load1 > 4.0:
        log.warning("[health] Load average %.1f is very high — CPU is starved.", load1)
    if fds > 500:
        log.warning("[health] %d open file descriptors — possible fd leak.", fds)
    if chrome_count > 20:
        log.warning("[health] %d chrome processes running — possible process leak.",
                    chrome_count)


# -------------------------------------------------------------------
# Logging
# -------------------------------------------------------------------

log = logging.getLogger("reddit_browser_subscriber")


def setup_logging(csv_path: Path, verbose: bool = False) -> Path:
    """Configure logging to both stderr and a sibling .log file."""
    log_path = csv_path.with_suffix(csv_path.suffix + ".log")
    level = logging.DEBUG if verbose else logging.INFO

    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s",
                            datefmt="%Y-%m-%d %H:%M:%S")

    root = logging.getLogger()
    for h in list(root.handlers):
        root.removeHandler(h)
    root.setLevel(level)

    stream = logging.StreamHandler(sys.stderr)
    stream.setFormatter(fmt)
    root.addHandler(stream)

    file_handler = logging.FileHandler(log_path, mode="a", encoding="utf-8")
    file_handler.setFormatter(fmt)
    root.addHandler(file_handler)

    return log_path


# -------------------------------------------------------------------
# CSV helpers (same logic as PRAW version — battle-tested)
# -------------------------------------------------------------------

def _looks_like_header(first_row: List[str]) -> bool:
    """Heuristic: does the first row look like a header?"""
    if not first_row:
        return False
    lowered = [c.strip().lower() for c in first_row]
    for cell in lowered:
        if cell in DEFAULT_INPUT_COLS:
            return True
    if len(first_row) > 1:
        for cell in lowered:
            if cell and not re.fullmatch(r"[a-z0-9_]+", cell, re.IGNORECASE):
                return True
    return False


def read_csv(path: Path) -> Tuple[List[str], List[Dict[str, str]]]:
    """Read a CSV file. Auto-detects header. Returns (fieldnames, rows)."""
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        all_rows = list(reader)

    if not all_rows:
        return ["subreddit"], []

    if _looks_like_header(all_rows[0]):
        fieldnames = [c.strip() or f"col_{i}" for i, c in enumerate(all_rows[0])]
        data_rows = all_rows[1:]
    else:
        ncols = max(len(r) for r in all_rows)
        if ncols <= 1:
            fieldnames = ["subreddit"]
        else:
            fieldnames = [f"col_{i}" for i in range(ncols)]
        data_rows = all_rows

    rows: List[Dict[str, str]] = []
    for raw in data_rows:
        padded = list(raw) + [""] * (len(fieldnames) - len(raw))
        rows.append(dict(zip(fieldnames, padded)))

    return fieldnames, rows


def detect_subreddit_column(fieldnames: List[str]) -> str:
    """Pick the column that contains subreddit names."""
    for candidate in DEFAULT_INPUT_COLS:
        if candidate in fieldnames:
            return candidate
    return fieldnames[0] if fieldnames else "subreddit"


def ensure_managed_columns(fieldnames: List[str]) -> List[str]:
    """Add the status / verification columns to the schema if missing."""
    new_fields = list(fieldnames)
    for col in MANAGED_COLS:
        if col not in new_fields:
            new_fields.append(col)
    return new_fields


def derive_status_path(csv_path: Path) -> Path:
    """
    Derive the status CSV path from the input CSV path.

    For an input file `subreddits.csv`, the status file is
    `subreddits.status.csv` in the SAME directory. This keeps the
    original input CSV untouched — the script reads it once and writes
    all updates to the status file.

    If the input is ALREADY a .status.csv file (e.g. selected from
    the dashboard dropdown), use it directly — don't create a
    .status.status.csv double-suffix file.

    Override with --status-csv if you want a custom location.
    """
    name = csv_path.name
    # If the file is already a .status.csv, use it as the status file directly.
    if name.lower().endswith(".status.csv"):
        return csv_path
    # Strip the .csv extension (if present) and append .status.csv
    # e.g. subs.csv → subs.status.csv
    # e.g. subs → subs.status.csv
    if name.lower().endswith(".csv"):
        name = name[:-4]
    return csv_path.with_name(name + ".status.csv")


def load_or_init_status(
    status_path: Path,
    input_fieldnames: List[str],
    input_rows: List[Dict[str, str]],
    sub_col: str,
) -> Tuple[List[str], List[Dict[str, str]]]:
    """
    Load the status CSV if it exists; otherwise initialize it from the
    input rows.

    Behavior:
    - If the status file exists, read it and return its (fieldnames, rows).
      The user is resuming a previous run.
    - If the status file does NOT exist, copy the input rows verbatim,
      add the managed columns (status='pending', etc.), write the initial
      status file, and return it.

    The input CSV is NEVER modified. Only the status file is written to.
    """
    if status_path.exists():
        log.info("Found existing status file: %s (resuming)", status_path)
        fields, rows = read_csv(status_path)
        # Make sure the status file has all the managed columns (in case
        # it was created by an older version of this script).
        fields = ensure_managed_columns(fields)
        for row in rows:
            for col in MANAGED_COLS:
                if col not in row:
                    row[col] = ""
            if not (row.get(STATUS_COL) or "").strip():
                row[STATUS_COL] = "pending"
        return fields, rows

    # No status file yet — initialize from input.
    log.info("No status file found. Initializing from input CSV: %s", status_path)
    # Start with the input fieldnames + managed columns.
    new_fields = ensure_managed_columns(list(input_fieldnames))
    # Deep-copy input rows so we don't mutate the originals.
    new_rows: List[Dict[str, str]] = []
    for input_row in input_rows:
        new_row = dict(input_row)  # shallow copy is fine — values are strings
        for col in MANAGED_COLS:
            if col not in new_row:
                new_row[col] = ""
        if not (new_row.get(STATUS_COL) or "").strip():
            new_row[STATUS_COL] = "pending"
        new_rows.append(new_row)

    # Write the initial status file so the dashboard can pick it up
    # immediately, before any subscriptions happen.
    write_csv_atomic(status_path, new_fields, new_rows)
    return new_fields, new_rows


def write_csv_atomic(path: Path, fieldnames: List[str], rows: List[Dict[str, str]]) -> None:
    """Write CSV to a temp file in the same dir, then rename -> atomic on POSIX."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=str(path.parent),
    )
    os.close(tmp_fd)
    tmp_path = Path(tmp_name)
    try:
        with tmp_path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
            writer.writeheader()
            for r in rows:
                writer.writerow({k: r.get(k, "") for k in fieldnames})
        os.replace(tmp_path, path)
    except Exception:
        try:
            tmp_path.unlink()
        except OSError:
            pass
        raise


def _normalize_sub_name(name: str) -> str:
    """Strip /r/ or r/ prefix, leading slashes, and whitespace."""
    name = (name or "").strip()
    if name.lower().startswith("/r/"):
        name = name[3:]
    elif name.lower().startswith("r/"):
        name = name[2:]
    name = name.lstrip("/")
    return name.strip()


# -------------------------------------------------------------------
# Random helpers (anti-bot pacing)
# -------------------------------------------------------------------

def jitter(low: float, high: float) -> float:
    """Random uniform float in [low, high]."""
    return random.uniform(low, high)


def sleep_jitter(low: float, high: float, desc: str = "") -> None:
    """Sleep for a random duration in [low, high] seconds."""
    t = jitter(low, high)
    if desc:
        log.debug("sleeping %.2fs (%s)", t, desc)
    time.sleep(t)


# -------------------------------------------------------------------
# Browser context management
# -------------------------------------------------------------------

class BrowserSession:
    """
    Wraps a Playwright sync browser session with persistent profile.

    On first run, opens a headful browser, navigates to reddit.com,
    and waits for the user to log in manually. Subsequent runs reuse
    the saved cookies.
    """

    def __init__(self, profile_dir: Path, headless: bool = False):
        self.profile_dir = profile_dir
        self.headless = headless
        self._playwright = None
        self._browser = None
        self._context = None
        self._stealth = None

    def start(self) -> None:
        """Launch the browser with the persistent profile."""
        # Import here so the script can be --help'd without playwright installed.
        from playwright.sync_api import sync_playwright
        try:
            from playwright_stealth import Stealth
            self._stealth = Stealth()
        except ImportError:
            log.warning("playwright-stealth not installed; proceeding without evasions.")
            self._stealth = None

        self.profile_dir.mkdir(parents=True, exist_ok=True)
        log.info("Launching browser with profile: %s", self.profile_dir)

        self._playwright = sync_playwright().start()

        launch_args = [
            "--disable-blink-features=AutomationControlled",
            "--no-first-run",
            "--no-default-browser-check",
        ]

        self._browser = self._playwright.chromium.launch_persistent_context(
            user_data_dir=str(self.profile_dir),
            headless=self.headless,
            args=launch_args,
            viewport={"width": 1280, "height": 800},
            locale="en-US",
            timezone_id="America/Chicago",
        )

        # Apply stealth evasions to the context (sync API).
        if self._stealth is not None:
            try:
                self._stealth.apply_stealth_sync(self._browser)
            except Exception as exc:
                log.warning("stealth apply failed: %s", exc)

        # ----------------------------------------------------------------
        # BLOCK UNNECESSARY RESOURCES — critical for Pi stability
        # ----------------------------------------------------------------
        # Each Reddit page load normally opens 50-100 TCP connections
        # (images, CSS, fonts, ads, tracking). These linger in TIME_WAIT
        # for 60-120s after closing. After ~23 rows × 100 connections,
        # the Pi's connection table overflows and the NETWORK INTERFACE
        # CRASHES — taking down SSH, VNC, and pi-hole.
        #
        # Fix: intercept and abort all non-essential resource requests.
        # We only need HTML + JS to find and click the Join button.
        # This cuts connections per page from ~100 to ~5.
        # ----------------------------------------------------------------
        BLOCKED_RESOURCE_TYPES = {
            "image",        # all images (icons, thumbnails, banners)
            "media",        # video, audio
            "font",         # web fonts (woff, woff2, ttf)
            "stylesheet",   # CSS files (we don't need styles to find a button)
        }

        # Domains to block entirely (ads, analytics, tracking)
        BLOCKED_DOMAINS = {
            "doubleclick.net",
            "googlesyndication.com",
            "google-analytics.com",
            "googletagmanager.com",
            "amazon-adsystem.com",
            "adsystem.com",
            "scorecardresearch.com",
            "quantserve.com",
            "adnxs.com",
            "criteo.com",
            "taboola.com",
            "outbrain.com",
            "adsrvr.org",
            "pubmatic.com",
            "rubiconproject.com",
            "openx.net",
            "casalemedia.com",
            "moatads.com",
            "adservice.google.com",
            "cdn.branch.io",
            "analytics.reddit.com",
            "events.reddit.com",
            "stats.g.doubleclick.net",
        }

        def _should_block(route):
            """Return True if this request should be blocked."""
            try:
                url = route.request.url
                resource_type = route.request.resource_type

                # Block by resource type
                if resource_type in BLOCKED_RESOURCE_TYPES:
                    return True

                # Block by domain
                url_lower = url.lower()
                for domain in BLOCKED_DOMAINS:
                    if domain in url_lower:
                        return True

                return False
            except Exception:
                return False

        def _handle_route(route):
            """Playwright route handler — aborts non-essential requests."""
            if _should_block(route):
                try:
                    route.abort()
                except Exception:
                    pass
            else:
                try:
                    route.continue_()
                except Exception:
                    pass

        try:
            self._browser.route("**/*", _handle_route)
            log.info("Resource blocking enabled (images, CSS, fonts, ads blocked)")
        except Exception as exc:
            log.warning("Failed to set up resource blocking: %s", exc)

    def ensure_logged_in(self, force_login_prompt: bool = False) -> str:
        """
        Navigate to reddit.com and ensure the user is logged in.

        Login strategy (in order):
        1. If REDDIT_USERNAME and REDDIT_PASSWORD env vars are set,
           auto-fill the login form (no manual interaction needed).
        2. If already logged in (cookies from previous session), skip.
        3. Otherwise, prompt the user to log in manually in the browser
           window (or via the dashboard's Continue button).

        Returns the logged-in username.
        """
        page = self._browser.new_page()
        try:
            log.info("Navigating to https://www.reddit.com/ ...")
            page.goto("https://www.reddit.com/", wait_until="domcontentloaded",
                      timeout=45_000)
            sleep_jitter(PAGE_LOAD_WAIT_MIN, PAGE_LOAD_WAIT_MAX, "let page settle")

            username = self._detect_logged_in_username(page)

            # Already logged in from a previous session (cookies persisted)
            if username and not force_login_prompt:
                log.info("Logged in as: /u/%s (from saved session)", username)
                return username

            # Check if credentials were provided for auto-login
            reddit_username = os.environ.get("REDDIT_USERNAME", "").strip()
            reddit_password = os.environ.get("REDDIT_PASSWORD", "").strip()

            if reddit_username and reddit_password and not force_login_prompt:
                log.info("Not logged in. Attempting auto-login for /u/%s ...",
                         reddit_username)
                auto_ok = self._auto_login(page, reddit_username, reddit_password)
                if auto_ok:
                    username = self._detect_logged_in_username(page)
                    if username:
                        log.info("Auto-login successful! Logged in as: /u/%s",
                                 username)
                        return username
                    else:
                        log.warning("Auto-login may have succeeded but could not "
                                    "detect username. Falling back to manual login.")
                else:
                    log.warning("Auto-login failed. Falling back to manual login.")

            # Fall back to manual login
            if force_login_prompt:
                log.info("Force-login requested.")
            else:
                log.info("Not logged in.")
            self._prompt_manual_login(page)
            username = self._detect_logged_in_username(page)
            if username is None:
                raise RuntimeError(
                    "Login verification failed. Even after manual login, "
                    "I can't detect your username. The script cannot continue."
                )

            log.info("Logged in as: /u/%s", username)
            return username
        finally:
            try:
                page.close()
            except Exception:
                pass

    def _auto_login(self, page, username: str, password: str) -> bool:
        """
        Automatically fill in the Reddit login form.
        Returns True if login appeared to succeed, False otherwise.

        This types the username and password into Reddit's login form.
        The browser window is visible (headful), so the user can watch
        the process and intervene if a CAPTCHA or 2FA prompt appears.
        """
        try:
            # Strategy 1: Look for the "Log In" button in the header
            # (sh.reddit.com / www.reddit.com modern UI)
            login_btn = None
            login_selectors = [
                'a[href*="login"]',
                'button:has-text("Log In")',
                'a:has-text("Log In")',
                '[aria-label*="Log in" i]',
                '[data-testid="login-button"]',
            ]
            for sel in login_selectors:
                try:
                    loc = page.locator(sel).first
                    if loc.count() > 0 and loc.is_visible(timeout=2000):
                        login_btn = loc
                        break
                except Exception:
                    continue

            if login_btn is None:
                # Maybe we're already on the login page
                log.info("  could not find 'Log In' button — trying login page directly")
                page.goto("https://www.reddit.com/login/",
                          wait_until="domcontentloaded", timeout=30_000)
                sleep_jitter(2.0, 4.0, "login page settle")
            else:
                log.info("  clicking 'Log In' button ...")
                login_btn.click(timeout=10_000)
                sleep_jitter(2.0, 4.0, "login form appear")

            # Now we should see the login form. Fill in username.
            # Reddit's login form uses various selectors across UI versions.
            username_selectors = [
                'input[name="username"]',
                'input[placeholder*="sername" i]',
                'input[type="text"]',
                'input[name="email"]',
                '#login-username',
                'input[data-testid="username"]',
            ]
            username_filled = False
            for sel in username_selectors:
                try:
                    loc = page.locator(sel).first
                    if loc.count() > 0 and loc.is_visible(timeout=2000):
                        loc.fill(username, timeout=5000)
                        log.info("  filled username")
                        username_filled = True
                        break
                except Exception:
                    continue

            if not username_filled:
                log.warning("  could not find username input field")
                return False

            sleep_jitter(0.5, 1.5, "between fields")

            # Fill in password
            password_selectors = [
                'input[name="password"]',
                'input[type="password"]',
                'input[placeholder*="assword" i]',
                '#login-password',
                'input[data-testid="password"]',
            ]
            password_filled = False
            for sel in password_selectors:
                try:
                    loc = page.locator(sel).first
                    if loc.count() > 0 and loc.is_visible(timeout=2000):
                        loc.fill(password, timeout=5000)
                        log.info("  filled password")
                        password_filled = True
                        break
                except Exception:
                    continue

            if not password_filled:
                log.warning("  could not find password input field")
                return False

            sleep_jitter(0.5, 1.5, "before submit")

            # Click the submit button
            submit_selectors = [
                'button[type="submit"]',
                'button:has-text("Log In")',
                'button:has-text("Sign In")',
                'button[data-testid="login-submit"]',
                'button.button-primary',
            ]
            submitted = False
            for sel in submit_selectors:
                try:
                    loc = page.locator(sel).first
                    if loc.count() > 0 and loc.is_visible(timeout=2000):
                        loc.click(timeout=10_000)
                        log.info("  clicked submit")
                        submitted = True
                        break
                except Exception:
                    continue

            if not submitted:
                # Try pressing Enter on the password field
                try:
                    page.keyboard.press("Enter")
                    log.info("  pressed Enter to submit")
                    submitted = True
                except Exception:
                    pass

            if not submitted:
                log.warning("  could not find submit button")
                return False

            # Wait for the page to redirect after login.
            # Give it up to 15 seconds — if there's a CAPTCHA or 2FA prompt,
            # the user can complete it manually in the visible browser window.
            log.info("  waiting for login to complete (15s timeout — if there's "
                     "a CAPTCHA, complete it manually in the browser window) ...")
            try:
                page.wait_for_url("**/www.reddit.com/**", timeout=15_000)
            except Exception:
                pass  # URL might not change if already on reddit.com

            sleep_jitter(3.0, 5.0, "post-login settle")

            # Check if we're now logged in
            check_username = self._detect_logged_in_username(page)
            if check_username:
                return True

            # If not detected, maybe there's a CAPTCHA or 2FA that the user
            # needs to complete. Wait a bit more and check again.
            log.info("  login may require CAPTCHA or 2FA — waiting 30s for "
                     "manual completion in browser window ...")
            sleep_jitter(30.0, 30.0, "waiting for CAPTCHA/2FA completion")

            check_username = self._detect_logged_in_username(page)
            return check_username is not None

        except Exception as exc:
            log.error("  auto-login error: %s", exc)
            return False

    def _detect_logged_in_username(self, page) -> Optional[str]:
        """
        Detect the logged-in username. Returns None if not logged in.

        Strategy (verified against real sh.reddit.com authenticated HTML):
        1. Check <shreddit-app user-logged-in="true"> — definitive login state.
           If absent or "false", the user is not logged in.
        2. Extract username from <achievements-entrypoint username="...">
           or <after-login-toast-dispatcher username="...">.
        3. Fallback to user-menu button's aria-label.
        4. Fallback to /api/v1/me fetch.
        """
        # Strategy 1: shreddit-app[user-logged-in] attribute — definitive.
        try:
            is_logged_in = page.evaluate(
                """
                () => {
                    const el = document.querySelector('shreddit-app');
                    if (!el) return null;
                    return el.getAttribute('user-logged-in');
                }
                """
            )
            log.debug("shreddit-app[user-logged-in] = %s", is_logged_in)
            if is_logged_in == "false" or is_logged_in is None:
                # Definitely not logged in (or page didn't load shreddit-app).
                # But still try the other strategies in case the attribute is missing.
                pass
        except Exception as exc:
            log.debug("shreddit-app login-check failed: %s", exc)

        # Strategy 2: extract username from known elements with username attribute.
        # Verified against real HTML: both <achievements-entrypoint> and
        # <after-login-toast-dispatcher> carry the actual username string.
        try:
            username = page.evaluate(
                """
                () => {
                    // Try multiple known elements that carry the username attribute.
                    const selectors = [
                        'achievements-entrypoint[username]',
                        'after-login-toast-dispatcher[username]',
                        'shreddit-app[user-logged-in="true"] ~ achievements-entrypoint[username]',
                    ];
                    for (const sel of selectors) {
                        const el = document.querySelector(sel);
                        if (el) {
                            const u = el.getAttribute('username');
                            if (u && u.length > 0 && u.length < 60) return u;
                        }
                    }
                    return null;
                }
                """
            )
            if username and isinstance(username, str) and len(username) < 60:
                log.debug("username detected via element attribute: %s", username)
                return username
        except Exception as exc:
            log.debug("username extraction via element attribute failed: %s", exc)

        # Strategy 3: user-menu button's aria-label.
        # Fallback for older UI versions or if the above elements aren't present.
        try:
            username = page.evaluate(
                """
                () => {
                    const el = document.querySelector(
                        '[aria-label*="avatar" i], [data-testid="user-menu"], ' +
                        '#USER_DROPDOWN_ID, button[aria-label*="Open user"], ' +
                        '#expand-user-drawer-button'
                    );
                    if (!el) return null;
                    const label = el.getAttribute('aria-label') || '';
                    // aria-labels look like "Open user menu (username)".
                    const m = label.match(/\\(([^()]+)\\)\\s*$/);
                    if (m) return m[1].trim();
                    return null;
                }
                """
            )
            if username and isinstance(username, str) and len(username) < 60:
                log.debug("username detected via aria-label: %s", username)
                return username
        except Exception as exc:
            log.debug("username extraction via aria-label failed: %s", exc)

        # Strategy 4: fetch /api/v1/me.
        try:
            username = page.evaluate(
                """
                async () => {
                    try {
                        const r = await fetch('/api/v1/me', {credentials: 'include'});
                        if (!r.ok) return null;
                        const j = await r.json();
                        return j.name || null;
                    } catch (e) { return null; }
                }
                """
            )
            if username and isinstance(username, str) and len(username) < 60:
                log.debug("username detected via /api/v1/me: %s", username)
                return username
        except Exception as exc:
            log.debug("username extraction via /api/v1/me failed: %s", exc)

        return None

    def _prompt_manual_login(self, page) -> None:
        """
        Print instructions and wait for the user to log in manually.
        The browser window is already open; user clicks around in it.
        """
        print("\n" + "=" * 60, file=sys.stderr)
        print("  MANUAL LOGIN REQUIRED", file=sys.stderr)
        print("=" * 60, file=sys.stderr)
        print(file=sys.stderr)
        print("  A browser window has opened. In that window:", file=sys.stderr)
        print(file=sys.stderr)
        print("    1. If not already on reddit.com, go to https://www.reddit.com", file=sys.stderr)
        print("    2. Click 'Log In' in the top-right corner", file=sys.stderr)
        print("    3. Enter your burner account credentials", file=sys.stderr)
        print("    4. Complete any 2FA / CAPTCHA prompts", file=sys.stderr)
        print("    5. Wait until you see your homepage feed", file=sys.stderr)
        print(file=sys.stderr)
        print("  The script will NOT type your password — you do it by hand.", file=sys.stderr)
        print("  Once you're logged in and see your feed, come back here and", file=sys.stderr)
        print("  press Enter to continue.", file=sys.stderr)
        print(file=sys.stderr)
        print("=" * 60, file=sys.stderr)
        try:
            input("  Press Enter when you're logged in... ")
        except EOFError:
            raise RuntimeError(
                "No interactive input available. Re-run in a real terminal, "
                "or pre-login by visiting reddit.com in the profile browser "
                "manually first."
            )
        # Give Reddit a moment to set cookies after login
        sleep_jitter(2.0, 4.0, "post-login cookie settle")

    def new_page(self):
        """Open a new page (tab) in the persistent context."""
        return self._browser.new_page()

    def close(self) -> None:
        """Close browser, persist cookies to profile dir.

        CRITICAL: Playwright's browser.close() does NOT kill all of
        Chromium's child processes (renderer, GPU, zygote). They become
        orphans and keep consuming RAM. On the Pi, this eventually triggers
        the OOM killer which takes down pi-hole and sshd.

        We forcefully kill ALL chrome processes after closing the browser
        to ensure no memory is leaked between runs.
        """
        if self._browser is not None:
            try:
                # Close all pages first
                for page in self._browser.pages:
                    try:
                        page.close()
                    except Exception:
                        pass
            except Exception:
                pass
            try:
                self._browser.close()
            except Exception:
                pass
        if self._playwright is not None:
            try:
                self._playwright.stop()
            except Exception:
                pass
        self._browser = None
        self._playwright = None

        # NUCLEAR OPTION: kill ALL chrome/chromium processes.
        # Playwright's close() leaves orphaned renderer/GPU processes
        # that continue consuming RAM. We must kill them all.
        kill_orphaned_chromium()
        # Small delay to let the OS reclaim the memory
        time.sleep(2)


# -------------------------------------------------------------------
# Shadowban detection
# -------------------------------------------------------------------

def check_shadowban(session: BrowserSession, username: str) -> Tuple[bool, str]:
    """
    Check whether the account is shadowbanned.

    Returns (is_shadowbanned, reason).
    A shadowbanned account's profile page returns 404 / "nothing here"
    even when accessed by the account itself.

    Method: fetch /user/{username}/about/.json with the session cookies.
    - If JSON has `.data` → not shadowbanned.
    - If JSON has `.reason == "THING_NOT_FOUND"` or returns 404 → shadowbanned.
    """
    page = session.new_page()
    try:
        url = ABOUT_URL_TEMPLATE.format(name=urllib.parse.quote(username))
        log.info("Shadowban check: fetching %s", url)
        try:
            response = page.goto(url, wait_until="domcontentloaded", timeout=30_000)
        except Exception as exc:
            return False, f"network error during shadowban check: {exc}"

        status = response.status if response else 0
        log.debug("shadowban-check HTTP status: %s", status)

        if status == 404:
            return True, "user profile returns 404 (shadowbanned)"

        try:
            body = response.text() if response else ""
        except Exception:
            body = ""

        # Try to parse as JSON
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            return False, "non-JSON response (assume not shadowbanned)"

        if isinstance(data, dict):
            if data.get("reason") == "THING_NOT_FOUND":
                return True, "user profile JSON says THING_NOT_FOUND (shadowbanned)"
            if "data" in data and isinstance(data["data"], dict):
                # Profile data present — not shadowbanned
                return False, ""
            if data.get("error"):
                return False, f"api error: {data.get('error')} (assume not shadowbanned)"

        return False, ""
    finally:
        try:
            page.close()
        except Exception:
            pass


# -------------------------------------------------------------------
# Subscription logic
# -------------------------------------------------------------------

class SubscribeResult:
    """Outcome of a single subscribe attempt."""
    SUBSCRIBED         = "subscribed"
    ALREADY_SUBSCRIBED = "already_subscribed"
    NOT_FOUND          = "not_found"
    BANNED             = "banned"
    PRIVATE            = "private"
    QUARANTINED        = "quarantined"
    FAILED             = "failed"


def _classify_subreddit_error(page_url: str, status: int, page_text: str) -> str:
    """
    Classify a subreddit page-load error based on HTTP status + page content.
    Returns a status string.
    """
    text_lower = (page_text or "").lower()
    if status == 404:
        if "banned" in text_lower:
            return SubscribeResult.BANNED
        if "private" in text_lower or "invite-only" in text_lower:
            return SubscribeResult.PRIVATE
        if "quarantined" in text_lower:
            return SubscribeResult.QUARANTINED
        return SubscribeResult.NOT_FOUND
    if status == 403:
        if "private" in text_lower:
            return SubscribeResult.PRIVATE
        if "quarantined" in text_lower:
            return SubscribeResult.QUARANTINED
        return SubscribeResult.BANNED
    if status == 451:  # legal reasons — usually quarantined
        return SubscribeResult.QUARANTINED
    return SubscribeResult.FAILED


def _find_join_button(page) -> Optional[object]:
    """
    Locate the Join button on a subreddit page.
    Returns the element handle, or None if not found.

    Strategy: try multiple selectors since Reddit's UI has several variants.
    The button lives inside <shreddit-subreddit-header-buttons>, which is a
    Web Component that renders its own shadow DOM at runtime.

    We use page.locator() with multiple fallback selectors and pick the first
    visible, enabled one.
    """
    # Build a list of CSS / XPath selectors to try, in priority order.
    # These cover sh.reddit.com (Web Components) AND old/new reddit (vanilla).
    selectors = [
        # sh.reddit.com — the Web Component renders a button with aria-label "Join"
        'shreddit-subreddit-header-buttons button[aria-label*="Join" i]',
        'shreddit-subreddit-header-buttons button:has-text("Join")',
        # New reddit (www.reddit.com)
        'button[data-testid="subscribe-button"]',
        'button[aria-label*="join" i]:not([aria-label*="joined" i])',
        # Old reddit fallback
        'a.fancy-toggle-button.add',
        '.subbutton',
        # Generic fallback — any button whose text is exactly "Join"
        'button:has-text("Join")',
    ]

    for sel in selectors:
        try:
            loc = page.locator(sel).first
            if loc.count() == 0:
                continue
            # Check visibility — `is_visible()` returns False for elements
            # that are display:none, hidden, or 0x0.
            try:
                if loc.is_visible(timeout=2000):
                    return loc
            except Exception:
                continue
        except Exception:
            continue
    return None


def _find_already_joined_indicator(page) -> bool:
    """
    Detect if the user is already subscribed to this subreddit.

    This is called BEFORE we attempt to click Join, so we can short-circuit
    and mark the row as already_subscribed instead of clicking.

    Detection methods (in priority order):
      1. A visible "Joined" button (aria-label or text content)
      2. A visible "Leave" / "Unsubscribe" button (only shown when joined)
      3. The Web Component's `subscribed` attribute on shreddit-subreddit-header-buttons
      4. JavaScript check via page.evaluate — reads the Web Component's state
      5. The user's subreddit list from the inline JSON (window.__r)

    Returns True if ANY of these signals indicate the user is subscribed.
    """
    # --- Method 1: CSS selectors for "Joined" button states ---
    already_indicators = [
        # sh.reddit.com — the Joined button (after subscription)
        'shreddit-subreddit-header-buttons button[aria-label*="Joined" i]',
        'shreddit-subreddit-header-buttons button:has-text("Joined")',
        # New reddit (www.reddit.com) — the Joined button
        'button[data-testid="unsubscribe-button"]',
        'button[aria-label*="joined" i]',
        # The "Leave" button is shown in a dropdown after Joined, but some
        # UI variants show it directly
        'button[aria-label*="Leave" i]',
        'button[aria-label*="leave" i]',
        'button[data-testid="leave-button"]',
        # Old reddit — the "leave" toggle
        'a.fancy-toggle-button.remove',
        'a.fancy-toggle-button:has-text("leave")',
        # Generic fallback — any button whose text is "Joined"
        'button:has-text("Joined")',
    ]
    for sel in already_indicators:
        try:
            loc = page.locator(sel).first
            if loc.count() > 0:
                try:
                    if loc.is_visible(timeout=1000):
                        return True
                except Exception:
                    # If is_visible times out, the element may still exist
                    # in the DOM — count it as subscribed
                    return True
        except Exception:
            continue

    # --- Method 2: Check the shreddit-subreddit-header-buttons component's state ---
    # The Web Component exposes its subscription state via attributes and
    # properties. Check several of them.
    try:
        # Check the `subscribed` attribute / property on the Web Component
        is_subscribed = page.evaluate(
            """
            () => {
                // Method A: Check the shreddit-subreddit-header-buttons element
                const header = document.querySelector('shreddit-subreddit-header-buttons');
                if (header) {
                    // The component exposes `subscribed` as a property
                    if (header.getAttribute('subscribed') === 'true') return true;
                    if (header.shadowRoot) {
                        // Look inside the shadow root for a Joined button
                        const joinedBtn = header.shadowRoot.querySelector(
                            'button[aria-label*="Joined" i], button:has-text("Joined")'
                        );
                        if (joinedBtn) return true;
                    }
                }

                // Method B: Check the inline JSON for the user's subscription state
                // Reddit embeds subreddit data in window.__r or a <script> tag
                const scripts = document.querySelectorAll('script[type="application/json"]');
                for (const s of scripts) {
                    try {
                        const text = s.textContent || '';
                        if (text.includes('"isSubscribed":true') ||
                            text.includes('"is_subscribed":true') ||
                            text.includes('"userIsSubscriber":true') ||
                            text.includes('"user_is_subscriber":true')) {
                            return true;
                        }
                    } catch (e) {}
                }

                // Method C: Check window.___r (Reddit's internal state)
                try {
                    const r = window.___r || window.__r;
                    if (r && r.traits && r.traits.subreddit) {
                        if (r.traits.subreddit.user_is_subscriber === true) return true;
                    }
                } catch (e) {}

                // Method D: Check for "Joined" text anywhere in the header area
                const headerArea = document.querySelector(
                    'shreddit-subreddit-header, .subreddit-header, [data-testid="subreddit-header"]'
                );
                if (headerArea && headerArea.textContent &&
                    headerArea.textContent.toLowerCase().includes('joined') &&
                    !headerArea.textContent.toLowerCase().includes('join')) {
                    return true;
                }

                return false;
            }
            """
        )
        if is_subscribed:
            return True
    except Exception as exc:
        log.debug("evaluate-based already-subscribed check failed: %s", exc)

    # --- Method 3: Check the subreddit's about.json via the logged-in cookie ---
    # This is a fallback — only use if the above methods didn't find anything,
    # because it makes an extra HTTP request.
    try:
        current_url = page.url
        # Extract subreddit name from URL (e.g. https://www.reddit.com/r/AskReddit/)
        import re
        match = re.search(r'/r/([A-Za-z0-9_]+)/?', current_url)
        if match:
            sub_name = match.group(1)
            # Use the page's existing session (cookies) to fetch the about.json
            result = page.evaluate(
                """
                async (subName) => {
                    try {
                        const res = await fetch(`https://www.reddit.com/r/${subName}/about.json`, {
                            credentials: 'include'
                        });
                        if (!res.ok) return false;
                        const data = await res.json();
                        // Check the user_is_subscriber field
                        if (data && data.data && data.data.user_is_subscriber === true) {
                            return true;
                        }
                        return false;
                    } catch (e) {
                        return false;
                    }
                }
                """,
                sub_name
            )
            if result:
                return True
    except Exception as exc:
        log.debug("about.json-based already-subscribed check failed: %s", exc)

    return False


def _dismiss_interstitials(page) -> None:
    """
    Dismiss any NSFW / age-verification / quarantine interstitials that
    Reddit might show before the subreddit content loads.

    Reddit shows several types of interstitials:
    1. NSFW age gate — "This community contains NSFW content" with a Continue button
    2. Age verification — "Are you over 18?" with Yes/No buttons
    3. Quarantine notice — "This community is quarantined" with a Continue button
    4. Banned community page — <guard-community-modal> (handled separately by error classification)

    This function NEVER raises — it's best-effort.
    """
    # Selectors for various interstitial buttons across Reddit UI versions.
    # We try each one in order; the first visible+clickable one gets clicked.
    interstitial_selectors = [
        # NSFW / age gate "Continue" button (sh.reddit.com)
        'button:has-text("Continue")',
        # Age verification "Yes" button
        'button:has-text("Yes")',
        'button:has-text("I am 18")',
        'button:has-text("I am over 18")',
        'button:has-text("I\'m over 18")',
        # NSFW content warning
        'button:has-text("I understand")',
        'button:has-text("Got it")',
        # Quarantine opt-in
        'button:has-text("I understand and wish to continue")',
        'button:has-text("Visit Community")',
        # Generic interstitial
        '[data-testid="interstitial-continue-button"]',
        '[data-testid="interstitial-continue"]',
        # Modal/dialog continue buttons
        'shreddit-async-loader button:has-text("Continue")',
        'rpl-modal-card button:has-text("Continue")',
    ]

    for sel in interstitial_selectors:
        try:
            loc = page.locator(sel).first
            if loc.count() > 0 and loc.is_visible(timeout=1000):
                log.info("  dismissing interstitial (clicked: %s)", sel)
                loc.click(timeout=5000)
                sleep_jitter(1.0, 2.0, "interstitial dismiss settle")
                # Don't return — there might be multiple interstitials (NSFW + age)
                # so we keep checking.
        except Exception:
            continue


def subscribe_one(session: BrowserSession, subreddit_name: str) -> Dict[str, str]:
    """
    Subscribe to a single subreddit by navigating to its page and clicking Join.

    NEVER raises — wraps everything in try/except so a single subreddit's
    failure (network error, page crash, anything) doesn't abort the whole run.
    Returns a dict with keys: status, error, subscribed_at.
    Also attempts to scrape subreddit metadata (members, description, etc.)
    from the page's inline JSON. The caller is responsible for storing these
    in the row; this function returns them under the 'scraped' key as a dict.
    """
    scraped: Dict[str, str] = {}
    try:
        name = _normalize_sub_name(subreddit_name)
        if not name:
            return {"status": SubscribeResult.NOT_FOUND,
                    "error": "empty subreddit name",
                    "subscribed_at": "",
                    "scraped": scraped}

        url = SUBREDDIT_URL_TEMPLATE.format(name=urllib.parse.quote(name))
        page = session.new_page()
        try:
            log.info("  navigating to %s", url)
            try:
                response = page.goto(url, wait_until="domcontentloaded", timeout=45_000)
            except Exception as exc:
                return {"status": SubscribeResult.FAILED,
                        "error": f"navigation error: {exc}",
                        "subscribed_at": "",
                        "scraped": scraped}

            # Wait for the page to settle (and let Web Components hydrate).
            sleep_jitter(PAGE_LOAD_WAIT_MIN, PAGE_LOAD_WAIT_MAX, "page settle")

            # Dismiss any NSFW / age-verification / quarantine interstitials
            # that Reddit might show before the subreddit content loads.
            # Called twice: once early (some interstitials appear immediately)
            # and once after the page settles (some appear after a delay).
            _dismiss_interstitials(page)

            # Check HTTP status — anything non-2xx means the sub doesn't exist
            # or is banned/private/quarantined.
            status_code = response.status if response else 0
            if status_code >= 400:
                try:
                    body_text = page.inner_text("body")
                except Exception:
                    body_text = ""
                classified = _classify_subreddit_error(url, status_code, body_text)
                return {
                    "status": classified,
                    "error": f"HTTP {status_code}: {body_text[:200]}",
                    "subscribed_at": "",
                    "scraped": scraped,
                }

            # Try to scrape subreddit metadata from the inline JSON.
            # Reddit embeds a JSON blob in a <script id="data"> tag on sh.reddit.com.
            # We pull: members, description, created_utc, is_nsfw, icon_url.
            scraped = _scrape_subreddit_metadata(page, name)

            # Dismiss any NSFW / age-verification / quarantine interstitials
            # that Reddit might show before the subreddit content loads.
            _dismiss_interstitials(page)

            # Wait for the header Web Component to render.
            # shreddit-subreddit-header-buttons is the container; the Join button
            # inside it is rendered after the component hydrates.
            try:
                page.wait_for_selector(
                    "shreddit-subreddit-header-buttons, .subreddit-header, "
                    "button[aria-label*='Join' i], button[aria-label*='Joined' i]",
                    timeout=15_000,
                )
            except Exception:
                log.debug("header component not detected within 15s")

            # Check if already subscribed
            if _find_already_joined_indicator(page):
                return {
                    "status": SubscribeResult.ALREADY_SUBSCRIBED,
                    "error": "",
                    "subscribed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "scraped": scraped,
                }

            # Find the Join button
            join_btn = _find_join_button(page)
            if join_btn is None:
                # Could not find the button. Check if the page is showing an
                # error like "this subreddit was banned" etc.
                try:
                    body_text = page.inner_text("body")
                except Exception:
                    body_text = ""
                body_lower = body_text.lower()
                if "banned" in body_lower:
                    return {"status": SubscribeResult.BANNED,
                            "error": "subreddit banned",
                            "subscribed_at": "",
                            "scraped": scraped}
                if "private" in body_lower or "invite-only" in body_lower:
                    return {"status": SubscribeResult.PRIVATE,
                            "error": "subreddit is private",
                            "subscribed_at": "",
                            "scraped": scraped}
                if "quarantined" in body_lower:
                    return {"status": SubscribeResult.QUARANTINED,
                            "error": "subreddit is quarantined (requires opt-in)",
                            "subscribed_at": "",
                            "scraped": scraped}
                return {"status": SubscribeResult.FAILED,
                        "error": f"could not find Join button on page. body sample: {body_text[:200]}",
                        "subscribed_at": "",
                        "scraped": scraped}

            # Human-like mouse movement before clicking: move to a random
            # offset within the button, hover, then click.
            try:
                box = join_btn.bounding_box()
                if box:
                    # Move mouse to a random point within the button, with steps
                    # to simulate a real cursor path.
                    target_x = box["x"] + box["width"] * random.uniform(0.2, 0.8)
                    target_y = box["y"] + box["height"] * random.uniform(0.2, 0.8)
                    # Move from current position (whatever it is) to target,
                    # in 10-20 small steps.
                    steps = random.randint(10, 20)
                    page.mouse.move(target_x, target_y, steps=steps)
                    sleep_jitter(PRE_CLICK_DELAY_MIN, PRE_CLICK_DELAY_MAX, "pre-click hover")
            except Exception as exc:
                log.debug("mouse-move failed (continuing): %s", exc)

            # Click the Join button
            log.info("  clicking Join ...")
            try:
                join_btn.click(timeout=10_000)
            except Exception as exc:
                return {"status": SubscribeResult.FAILED,
                        "error": f"click failed: {exc}",
                        "subscribed_at": "",
                        "scraped": scraped}

            # Wait for the network to settle after the click.
            sleep_jitter(POST_CLICK_WAIT_MIN, POST_CLICK_WAIT_MAX, "post-click settle")

            # Verify the click took effect: the Join button should now say Joined.
            # Wait up to 8s for the button text to change.
            try:
                page.wait_for_function(
                    """
                    () => {
                        const btns = document.querySelectorAll(
                            'shreddit-subreddit-header-buttons button, ' +
                            'button[aria-label*="Joined" i], button[aria-label*="Join" i]'
                        );
                        for (const b of btns) {
                            const label = (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '');
                            if (label.toLowerCase().includes('joined')) return true;
                        }
                        return false;
                    }
                    """,
                    timeout=8_000,
                )
                return {
                    "status": SubscribeResult.SUBSCRIBED,
                    "error": "",
                    "subscribed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "scraped": scraped,
                }
            except Exception:
                # Button didn't change to "Joined" within 8s.
                # Check one more time using our indicator function.
                if _find_already_joined_indicator(page):
                    return {
                        "status": SubscribeResult.SUBSCRIBED,
                        "error": "",
                        "subscribed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                        "scraped": scraped,
                    }
                return {"status": SubscribeResult.FAILED,
                        "error": "Join button clicked but state did not change to Joined",
                        "subscribed_at": "",
                        "scraped": scraped}
        finally:
            try:
                page.close()
            except Exception:
                pass
    except Exception as exc:
        # Catch-all: ANY unexpected exception in subscribe_one is converted to
        # a 'failed' status. The pipeline continues to the next row.
        log.error("  unexpected error in subscribe_one for r/%s: %s",
                  _normalize_sub_name(subreddit_name), exc)
        log.debug("traceback:\n%s", traceback.format_exc())
        return {
            "status": SubscribeResult.FAILED,
            "error": f"unexpected error: {type(exc).__name__}: {exc}",
            "subscribed_at": "",
            "scraped": {},
        }


def _scrape_subreddit_metadata(page, name: str) -> Dict[str, str]:
    """
    Scrape subreddit metadata (members, description, age, NSFW, icon)
    from the page's inline JSON. sh.reddit.com embeds a JSON blob in a
    <script id="data"> tag containing all subreddit info.

    Returns a dict with keys matching SCRAPED_COLS (some may be empty).
    NEVER raises — scraping is best-effort.
    """
    result: Dict[str, str] = {
        MEMBERS_COL: "",
        DESCRIPTION_COL: "",
        CREATED_COL: "",
        NSFW_COL: "",
        ICON_COL: "",
    }

    # Strategy 1: parse the inline <script id="data"> JSON blob.
    # sh.reddit.com puts subreddit info in window.__INITIAL_STATE__ or
    # a <script id="data"> tag.
    try:
        data = page.evaluate(
            r"""
            () => {
                // Try multiple sources of subreddit data on the page.
                const sources = [];

                // 1. <script id="data"> tag (sh.reddit.com)
                const dataScript = document.getElementById('data')
                                  || document.querySelector('script[data-client-seconds]');
                if (dataScript && dataScript.textContent) {
                    sources.push(dataScript.textContent);
                }

                // 2. window.__INITIAL_STATE__ (sometimes set)
                if (window.__INITIAL_STATE__) {
                    try { sources.push(JSON.stringify(window.__INITIAL_STATE__)); }
                    catch (e) {}
                }

                // 3. <script type="application/ld+json"> (SEO data)
                document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
                    if (s.textContent) sources.push(s.textContent);
                });

                // Look for subreddit data in any source.
                for (const text of sources) {
                    if (!text) continue;
                    // Try parsing as JSON first.
                    try {
                        const j = JSON.parse(text);
                        // Walk the object looking for a subreddit node.
                        const found = (function walk(o, depth) {
                            if (!o || typeof o !== 'object' || depth > 8) return null;
                            // Heuristic: has display_name and subscribers or
                            // public_description.
                            if (o.display_name &&
                                (o.subscribers !== undefined ||
                                 o.public_description !== undefined ||
                                 o.subreddit_type !== undefined)) {
                                return o;
                            }
                            for (const k of Object.keys(o)) {
                                const v = o[k];
                                if (v && typeof v === 'object') {
                                    const r = walk(v, depth + 1);
                                    if (r) return r;
                                }
                            }
                            return null;
                        })(j, 0);
                        if (found) return found;
                    } catch (e) {}

                    // Fallback: regex extract from raw text.
                    const m = text.match(/"subscribers":\s*(\d+)/);
                    if (m) {
                        return {
                            subscribers: parseInt(m[1], 10),
                            _source: 'regex'
                        };
                    }
                }
                return null;
            }
            """
        )
        if isinstance(data, dict):
            # Members
            subs = data.get("subscribers") or data.get("subscriberCount")
            if subs is not None:
                result[MEMBERS_COL] = str(subs)
            # Description
            desc = (data.get("public_description") or data.get("description")
                    or data.get("description_html") or "")
            if isinstance(desc, str):
                result[DESCRIPTION_COL] = desc[:500]
            # Created
            created = data.get("created_utc") or data.get("created")
            if created is not None:
                # Could be epoch float or ISO string.
                result[CREATED_COL] = str(created)
            # NSFW
            nsfw = data.get("over18")
            if nsfw is None:
                nsfw = data.get("is_nsfw")
            if nsfw is None:
                nsfw = data.get("nsfw")
            if nsfw is not None:
                result[NSFW_COL] = "true" if nsfw else "false"
            # Icon
            icon = data.get("icon_img") or data.get("community_icon") or data.get("icon_url")
            if isinstance(icon, str) and icon:
                result[ICON_COL] = icon[:500]
    except Exception as exc:
        log.debug("metadata scrape from inline JSON failed: %s", exc)

    # Strategy 2: read the shreddit-subreddit-header element's attributes.
    # Verified against real authenticated HTML — this element has:
    #   description="r/AskReddit is the place to ask and answer thought-provoking questions."
    #   weekly-active-users="12504632"
    #   weekly-contributions="1023972"
    #   display-name="Ask Reddit..."
    #   subreddit-id="t5_2qh1i"
    #   prefixed-name="r/AskReddit"
    # Also check the sidebar's <shreddit-subreddit-header> with slot="community-details"
    # for the Created date (faceplate-timeago[ts="2008-01-25T03:52:15.108000+0000"]).
    try:
        if not result[MEMBERS_COL]:
            wau = page.get_attribute("shreddit-subreddit-header", "weekly-active-users")
            if wau:
                result[MEMBERS_COL] = f"~{wau} weekly active"
        if not result[DESCRIPTION_COL]:
            desc = page.get_attribute("shreddit-subreddit-header", "description")
            if desc:
                result[DESCRIPTION_COL] = desc[:500]
    except Exception:
        pass

    # Strategy 2b: extract the "Created" date from the sidebar's
    # faceplate-timeago element inside shreddit-subreddit-header.
    if not result[CREATED_COL]:
        try:
            created_ts = page.evaluate(
                """
                () => {
                    // Find the cake icon's tooltip, which contains a faceplate-timeago
                    // element with the 'ts' attribute = ISO-8601 creation timestamp.
                    const t = document.querySelector(
                        'shreddit-subreddit-header faceplate-timeago[ts], ' +
                        'shreddit-subreddit-header time[datetime]'
                    );
                    if (t) {
                        return t.getAttribute('ts') || t.getAttribute('datetime') || null;
                    }
                    return null;
                }
                """
            )
            if created_ts and isinstance(created_ts, str):
                # Could be ISO-8601 or epoch. Normalize to epoch float for consistency.
                result[CREATED_COL] = created_ts
        except Exception:
            pass

    # Strategy 3: regex fallback against the raw HTML.
    if not result[MEMBERS_COL] or not result[DESCRIPTION_COL]:
        try:
            html = page.content()
            if not result[MEMBERS_COL]:
                m = re.search(r'"subscribers":\s*(\d+)', html)
                if m:
                    result[MEMBERS_COL] = m.group(1)
            if not result[DESCRIPTION_COL]:
                m = re.search(
                    r'"public_description":\s*"((?:[^"\\]|\\.)*)"',
                    html,
                )
                if m:
                    # Unescape JSON string escapes.
                    desc = m.group(1).encode().decode('unicode_escape')
                    result[DESCRIPTION_COL] = desc[:500]
            if not result[CREATED_COL]:
                m = re.search(r'"created_utc":\s*([0-9.]+)', html)
                if m:
                    result[CREATED_COL] = m.group(1)
            if not result[NSFW_COL]:
                m = re.search(r'"over18":\s*(true|false)', html, re.IGNORECASE)
                if m:
                    result[NSFW_COL] = "true" if m.group(1).lower() == "true" else "false"
        except Exception as exc:
            log.debug("metadata regex fallback failed: %s", exc)

    log.debug("scraped r/%s: %s", name, result)
    return result


# -------------------------------------------------------------------
# Verification logic
# -------------------------------------------------------------------

def fetch_subscribed_subreddits(session: BrowserSession) -> Set[str]:
    """
    Fetch the set of subreddit display_names the user is currently
    subscribed to, by navigating to /subreddits/mine/.json (which
    returns paginated JSON when authenticated by the session cookies).
    Handles pagination via the `after` cursor.
    """
    log.info("Fetching current subreddit subscriptions from /subreddits/mine/.json ...")
    names: Set[str] = set()
    page = session.new_page()
    try:
        after = ""
        page_count = 0
        while True:
            page_count += 1
            url = VERIFY_URL_TEMPLATE
            if after:
                url += f"&after={urllib.parse.quote(after)}"
            log.info("  page %d: %s", page_count, url)
            try:
                response = page.goto(url, wait_until="domcontentloaded", timeout=45_000)
            except Exception as exc:
                log.error("Failed to fetch subscriptions page %d: %s", page_count, exc)
                break

            status = response.status if response else 0
            if status != 200:
                log.error("Subscriptions endpoint returned HTTP %d", status)
                break

            try:
                body = response.text()
                data = json.loads(body)
            except Exception as exc:
                log.error("Failed to parse subscriptions JSON: %s", exc)
                break

            if not isinstance(data, dict):
                log.error("Unexpected subscriptions response shape: %r", type(data))
                break

            children = data.get("data", {}).get("children", [])
            if not children:
                log.info("  page %d: no more children", page_count)
                break

            for child in children:
                try:
                    display_name = child.get("data", {}).get("display_name", "")
                    if display_name:
                        names.add(display_name.lower())
                except Exception:
                    continue

            after = data.get("data", {}).get("after", "")
            if not after:
                log.info("  page %d: no 'after' cursor — end of pagination", page_count)
                break

            # Safety valve — never infinite-loop
            if page_count >= 100:
                log.warning("Hit 100 pages of subscriptions; stopping pagination.")
                break

            # Polite delay between pagination calls
            sleep_jitter(1.0, 2.5, "between pagination calls")
    finally:
        try:
            page.close()
        except Exception:
            pass

    log.info("Currently subscribed to %d subreddits.", len(names))
    return names


# -------------------------------------------------------------------
# Pipeline passes
# -------------------------------------------------------------------

def run_subscribe_pass(
    session: BrowserSession,
    username: str,
    csv_path: Path,
    sub_col: str,
    fieldnames: List[str],
    rows: List[Dict[str, str]],
    max_subscribes: int = MAX_SUBSCRIBES_PER_SESSION,
) -> None:
    """Iterate CSV and subscribe to each pending row.

    This function NEVER raises — every per-row error is caught, marked as
    'failed' on the row, and the loop continues to the next row. Only
    catastrophic failures (shadowban detected, browser died) abort early.
    """
    total = len(rows)
    log.info("=== SUBSCRIBE PASS === %d total rows", total)

    # Check internet connectivity before starting. If the connection is down
    # (e.g. Pi lost Wi-Fi), wait until it's back before proceeding.
    wait_for_internet()

    # Pre-flight shadowban check.
    try:
        is_banned, reason = check_shadowban(session, username)
    except Exception as exc:
        log.warning("Pre-flight shadowban check errored (continuing): %s", exc)
        is_banned, reason = False, f"shadowban check error: {exc}"
    if is_banned:
        log.error("PRE-FLIGHT SHADOWBAN CHECK FAILED: %s", reason)
        log.error("Aborting subscribe pass. Mark all pending rows as 'shadowbanned'.")
        now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
        for row in rows:
            current = (row.get(STATUS_COL) or "pending").strip()
            if current in DONE_STATUSES or current in TERMINAL_STATUSES:
                continue
            if current == "shadowbanned":
                continue
            row[STATUS_COL]        = "shadowbanned"
            row[ERROR_COL]         = reason
            row[SUBSCRIBED_AT_COL] = now_iso
        write_csv_atomic(csv_path, fieldnames, rows)
        return

    log.info("Pre-flight shadowban check: account is clean.")

    pending_start = sum(1 for r in rows
                        if (r.get(STATUS_COL) or "pending") not in DONE_STATUSES
                        and (r.get(STATUS_COL) or "pending") not in TERMINAL_STATUSES)
    log.info("Rows pending subscription: %d", pending_start)

    subscribe_count = 0
    consecutive_failures = 0
    aborted_reason: Optional[str] = None

    # --- PRIORITY SORTING -------------------------------------------------
    # Process rows in this order:
    #   1. pending         (highest — never been touched)
    #   2. failed          (retryable — last run errored)
    #   3. shadowbanned    (retryable — last run was shadowbanned)
    #   4. aborted         (retryable — last run hit session cap)
    #   SKIP:
    #   5. subscribed / already_subscribed  (DONE — unless --verify-only)
    #   6. not_found / banned / private / quarantined  (TERMINAL — skip)
    #
    # This gets the actual work done first instead of iterating through
    # 4000 already-subscribed rows to find the 5 pending ones.
    #
    # We DON'T reorder the underlying `rows` list (which would mess up the
    # CSV file). Instead we build a list of indices in priority order and
    # iterate that.
    def _priority(status: str) -> int:
        # Failed rows are processed FIRST so they get retried immediately
        # at the start of each run, before any new pending rows.
        if status == "failed":
            return 0
        if status == "pending":
            return 1
        if status == "shadowbanned":
            return 2
        if status == "aborted":
            return 3
        if status in DONE_STATUSES:
            return 4
        if status in TERMINAL_STATUSES:
            return 5
        return 1  # unknown statuses treated as pending

    # Build (priority, original_index, row) tuples, then sort.
    # Using original_index as tiebreaker keeps CSV order stable within each
    # priority bucket.
    indexed_rows = sorted(
        enumerate(rows),
        key=lambda pair: (_priority((pair[1].get(STATUS_COL) or "pending").strip()), pair[0])
    )

    # Count what's in each bucket (for logging)
    bucket_counts: Dict[str, int] = {}
    for _, r in indexed_rows:
        s = (r.get(STATUS_COL) or "pending").strip()
        bucket_counts[s] = bucket_counts.get(s, 0) + 1
    log.info("Row priority breakdown:")
    for status, count in sorted(bucket_counts.items(), key=lambda x: -x[1]):
        log.info("  %-20s %5d", status, count)

    for i, (original_idx, row) in enumerate(indexed_rows, 1):
        raw_name = row.get(sub_col, "")
        name = _normalize_sub_name(raw_name)
        current_status = (row.get(STATUS_COL) or "pending").strip()

        # Check if the auto-update system has set the pause flag.
        # If so, block here until the update is done, then continue.
        wait_if_paused()

        # Check internet connectivity. If we've lost connection mid-run
        # (e.g. Wi-Fi dropped), wait for it to come back before continuing.
        if not check_internet_connection(timeout=5.0):
            wait_for_internet()

        # --- SYSTEM HEALTH LOGGING ---
        # Log full system health every 10 subscribes to diagnose what's
        # actually causing the Pi to become unresponsive over time.
        # This logs RAM, CPU temp, load average, file descriptors, and
        # chrome process count.
        if subscribe_count > 0 and subscribe_count % 10 == 0:
            log_system_health(f"every 10 subs (count={subscribe_count})")

            # --- NETWORK COOLDOWN ---
            # Every 10 subscribes, pause for 2 minutes to let all TCP
            # connections fully close. Without this, connections accumulate
            # in TIME_WAIT state and eventually crash the Pi's network
            # interface (taking down SSH, VNC, and pi-hole).
            log.info("Network cooldown — pausing 120s to let TCP connections close...")
            time.sleep(120)
            log.info("Cooldown complete. Continuing.")

        # --- RESOURCE CHECK ---
        # Check available RAM and disk space. If RAM is low, pause and wait
        # for memory to be freed (protects pi-hole, sshd from OOM killer).
        # If disk is critically low, abort the run entirely.
        if not check_system_resources(str(csv_path.parent)):
            log.error("Aborting run due to low system resources.")
            aborted_reason = "low system resources (disk full)"
            break

        # --- BROWSER RESTART ---
        # Restart the browser every BROWSER_RESTART_EVERY_N subscribes to
        # release Chromium's leaked memory. Without this, Chromium
        # accumulates RAM over thousands of page loads and eventually
        # triggers the OOM killer, which takes down pi-hole and sshd.
        if subscribe_count > 0 and subscribe_count % BROWSER_RESTART_EVERY_N == 0:
            ram_before = get_available_ram_mb()
            log.info("Restarting browser to release memory (every %d subscribes)...",
                     BROWSER_RESTART_EVERY_N)
            log.info("  RAM before restart: %.0f MB", ram_before)
            try:
                # close() now kills ALL orphaned Chromium processes
                session.close()
                # Extra safety: kill any that survived
                killed = kill_orphaned_chromium()
                if killed > 0:
                    log.info("  Killed %d additional orphaned process(es).", killed)
                # Wait for OS to reclaim the memory
                time.sleep(5)
                ram_after_kill = get_available_ram_mb()
                log.info("  RAM after kill: %.0f MB (freed %.0f MB)",
                         ram_after_kill, ram_after_kill - ram_before)
                # Restart the browser
                session.start()
                username = session.ensure_logged_in()
                ram_after_restart = get_available_ram_mb()
                log.info("Browser restarted. RAM available: %.0f MB",
                         ram_after_restart)
                log_system_health("after browser restart")
            except Exception as exc:
                log.error("Browser restart failed: %s", exc)
                log.error("Aborting run to prevent system instability.")
                aborted_reason = f"browser restart failed: {exc}"
                break

        if not name:
            row[STATUS_COL]        = SubscribeResult.NOT_FOUND
            row[ERROR_COL]         = "empty subreddit name"
            row[SUBSCRIBED_AT_COL] = ""
            write_csv_atomic(csv_path, fieldnames, rows)
            continue

        # Skip rows we've already successfully handled (resume support).
        if current_status in DONE_STATUSES:
            log.debug("[%d/%d] r/%s — skip (already %s)", i, total, name, current_status)
            continue

        # Skip terminal-status rows too (banned / not_found / etc.).
        if current_status in TERMINAL_STATUSES:
            log.info("[%d/%d] r/%s — skip (terminal: %s)", i, total, name, current_status)
            continue

        # Already hit the session cap?
        if subscribe_count >= max_subscribes:
            log.warning("Reached session cap of %d subscribes. "
                        "Remaining rows left as 'pending'. Re-run tomorrow.", max_subscribes)
            log.warning("Run with --max-subscribes to override.")
            aborted_reason = f"session cap reached ({max_subscribes})"
            # Don't return — we still want to run the rest of the loop body
            # for the remaining rows? No — we want to mark them as 'aborted'
            # so the dashboard knows. But we also don't want to overwrite
            # rows that are already 'pending' with 'aborted' since the user
            # might re-run with a higher cap. Keep them as 'pending'.
            # Just break.
            break

        # Mid-run shadowban re-check?
        if consecutive_failures >= SHADOWBAN_CHECK_THRESHOLD:
            log.warning("%d consecutive failures — re-checking shadowban status ...",
                        consecutive_failures)
            try:
                is_banned, reason = check_shadowban(session, username)
            except Exception as exc:
                log.warning("Mid-run shadowban check errored (continuing): %s", exc)
                is_banned, reason = False, f"shadowban check error: {exc}"
            if is_banned:
                log.error("MID-RUN SHADOWBAN DETECTED: %s", reason)
                log.error("Aborting. Marking remaining pending rows as 'shadowbanned'.")
                now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
                for r in rows[i-1:]:
                    s = (r.get(STATUS_COL) or "pending").strip()
                    if s in DONE_STATUSES or s in TERMINAL_STATUSES:
                        continue
                    r[STATUS_COL]        = "shadowbanned"
                    r[ERROR_COL]         = reason
                    r[SUBSCRIBED_AT_COL] = now_iso
                write_csv_atomic(csv_path, fieldnames, rows)
                return
            else:
                log.info("Shadowban re-check: clean. Resetting failure counter.")
                consecutive_failures = 0

        log.info("[%d/%d] Subscribing to r/%s ...", i, total, name)

        # === CONTINUE-ON-ERROR BOUNDARY ===
        # subscribe_one NEVER raises (it has a top-level try/except that
        # converts any exception to status='failed'). But we add another
        # safety net here in case there's a bug in subscribe_one itself
        # (e.g., it imports something that throws at module level).
        try:
            result = subscribe_one(session, name)
        except Exception as exc:
            # This should never happen — subscribe_one is supposed to be
            # exception-safe. But if it does, mark the row as failed and
            # CONTINUE to the next row.
            log.error("  BUG: subscribe_one raised an exception (it shouldn't). "
                      "Marking row as failed and continuing.")
            log.error("  exception: %s: %s", type(exc).__name__, exc)
            log.debug("traceback:\n%s", traceback.format_exc())
            result = {
                "status": SubscribeResult.FAILED,
                "error": f"subscribe_one bug: {type(exc).__name__}: {exc}",
                "subscribed_at": "",
                "scraped": {},
            }

        row[STATUS_COL]        = result["status"]
        row[ERROR_COL]         = result["error"]
        row[SUBSCRIBED_AT_COL] = result["subscribed_at"]

        # Store scraped metadata into the row (don't overwrite non-empty
        # existing values with empty ones).
        scraped = result.get("scraped", {}) or {}
        for col in SCRAPED_COLS:
            new_val = scraped.get(col, "")
            if new_val:
                row[col] = new_val
            elif col not in row:
                row[col] = ""

        if result["status"] == SubscribeResult.SUBSCRIBED:
            log.info("  -> subscribed")
            subscribe_count += 1
            consecutive_failures = 0
        elif result["status"] == SubscribeResult.ALREADY_SUBSCRIBED:
            log.info("  -> already subscribed")
            # Count toward session cap — we still loaded the page and made
            # an API call to Reddit's servers, so it counts against rate limits.
            subscribe_count += 1
            consecutive_failures = 0
        elif result["status"] in TERMINAL_STATUSES:
            log.info("  -> %s", result["status"])
            consecutive_failures = 0
        else:
            log.warning("  -> %s: %s", result["status"], result["error"])
            consecutive_failures += 1

        # Persist after every row so progress survives a crash mid-run.
        write_csv_atomic(csv_path, fieldnames, rows)

        # Anti-shadowban pacing between rows.
        if i < total:
            sleep_jitter(INTER_ROW_DELAY_MIN, INTER_ROW_DELAY_MAX,
                         f"inter-row delay (row {i})")

            # Periodic batch break — triggers right after we hit a multiple of
            # BATCH_BREAK_EVERY_N successful subscribes.
            if subscribe_count > 0 and subscribe_count % BATCH_BREAK_EVERY_N == 0:
                break_time = jitter(BATCH_BREAK_MIN, BATCH_BREAK_MAX)
                log.info("=== BATCH BREAK === %d subscribes done. "
                         "Sleeping %.1fs before continuing.",
                         subscribe_count, break_time)
                time.sleep(break_time)

    # Summary
    counts: Dict[str, int] = {}
    for r in rows:
        s = (r.get(STATUS_COL) or "pending").strip() or "pending"
        counts[s] = counts.get(s, 0) + 1
    log.info("=== SUBSCRIBE PASS COMPLETE ===")
    for s in sorted(counts):
        log.info("  %-25s %d", s, counts[s])
    log.info("Subscribed this session: %d (cap was %d)", subscribe_count, max_subscribes)
    if aborted_reason:
        log.info("Aborted early: %s", aborted_reason)


def run_verify_pass(
    session: BrowserSession,
    csv_path: Path,
    sub_col: str,
    fieldnames: List[str],
    rows: List[Dict[str, str]],
) -> None:
    """Compare CSV statuses against the user's actual subscribed subreddits."""
    log.info("=== VERIFY PASS ===")
    actual = fetch_subscribed_subreddits(session)

    verified_count = 0
    unverified_count = 0
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")

    for row in rows:
        name = _normalize_sub_name(row.get(sub_col, "")).lower()
        if name and name in actual:
            row[VERIFIED_COL]    = "verified"
            verified_count += 1
        else:
            row[VERIFIED_COL]    = "unverified"
            unverified_count += 1
        row[VERIFIED_AT_COL] = now_iso

    write_csv_atomic(csv_path, fieldnames, rows)
    log.info("Verification: %d verified, %d unverified",
             verified_count, unverified_count)

    mismatches = [
        (row.get(sub_col, ""), row.get(STATUS_COL, ""))
        for row in rows
        if row.get(VERIFIED_COL) == "unverified"
        and (row.get(STATUS_COL) or "") in DONE_STATUSES
    ]
    if mismatches:
        log.warning("WARNING: %d row(s) claim subscribed but are NOT in live subscription set:",
                    len(mismatches))
        for name, status in mismatches[:10]:
            log.warning("  r/%s (csv status=%s)", name, status)
        if len(mismatches) > 10:
            log.warning("  ... and %d more", len(mismatches) - 10)


# -------------------------------------------------------------------
# CLI
# -------------------------------------------------------------------

def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="reddit_browser_subscriber.py",
        description="Mass-subscribe to subreddits from a CSV via browser automation.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Examples
--------
  # First run (opens a browser, you log in manually, press Enter to continue):
    python reddit_browser_subscriber.py --csv subs.csv

  # Subsequent runs (cookies saved, no login needed):
    python reddit_browser_subscriber.py --csv subs.csv

  # Verify-only (re-check the CSV against your live subscriptions):
    python reddit_browser_subscriber.py --csv subs.csv --verify-only

  # Retry rows previously marked 'failed':
    python reddit_browser_subscriber.py --csv subs.csv --reprocess-failed

  # Increase session cap (risky — higher shadowban chance):
    python reddit_browser_subscriber.py --csv subs.csv --max-subscribes 200
""",
    )
    p.add_argument("--csv", required=True, help="Path to the input CSV of subreddits. "
                        "This file is NEVER modified — the script writes status "
                        "updates to a separate file (see --status-csv).")
    p.add_argument("--status-csv", default=None,
                   help="Path to the status CSV (where per-row status is written). "
                        "Default: <input>.status.csv in the same directory as --csv. "
                        "The input CSV is left untouched.")
    p.add_argument("--profile-dir", default=str(DEFAULT_PROFILE_DIR),
                   help=f"Browser profile directory (default: {DEFAULT_PROFILE_DIR}). "
                        "Stores cookies so you only log in once.")
    p.add_argument("--headless", action="store_true",
                   help="Run browser headless (NOT recommended — higher shadowban risk).")
    p.add_argument("--verify-only",   action="store_true",
                   help="Only run the verification pass (no subscribing).")
    p.add_argument("--subscribe-only", action="store_true",
                   help="Only run the subscribe pass (skip verification).")
    p.add_argument("--reprocess-failed", action="store_true",
                   help="Reset rows previously marked 'failed' OR 'shadowbanned' "
                        "back to 'pending' and retry. Use this when switching to "
                        "a new account.")
    p.add_argument("--max-subscribes", type=int, default=MAX_SUBSCRIBES_PER_SESSION,
                   help=f"Hard cap on subscribes per session (default: "
                        f"{MAX_SUBSCRIBES_PER_SESSION}).")
    p.add_argument("--force-login", action="store_true",
                   help="Force the manual login prompt even if already logged in.")
    p.add_argument("--verbose", action="store_true",
                   help="Enable debug logging.")
    return p


def main() -> None:
    args = build_arg_parser().parse_args()

    csv_path = Path(args.csv).expanduser().resolve()
    if not csv_path.exists():
        print(f"ERROR: CSV file not found: {csv_path}", file=sys.stderr)
        sys.exit(2)

    # Derive (or use override) the status CSV path. The input CSV is read
    # ONCE at startup; all writes go to the status CSV. The input is
    # never modified.
    if args.status_csv:
        status_path = Path(args.status_csv).expanduser().resolve()
    else:
        status_path = derive_status_path(csv_path)

    profile_dir = Path(args.profile_dir).expanduser().resolve()

    # Set up logging to a file next to the INPUT csv (not the status file),
    # so the user can find it where they expect it.
    log_path = setup_logging(csv_path, verbose=args.verbose)

    # Read the INPUT csv once — just to discover the schema and the list
    # of subreddits. We never write to this file.
    input_fieldnames, input_rows = read_csv(csv_path)
    sub_col = detect_subreddit_column(input_fieldnames)

    # Load or initialize the status CSV. If the status file already exists
    # (from a previous run), we resume from it. Otherwise we initialize
    # it from the input and write the initial state to disk immediately.
    fieldnames, rows = load_or_init_status(status_path, input_fieldnames, input_rows, sub_col)

    log.info("Input CSV:  %s (READ-ONLY — never modified)", csv_path)
    log.info("Status CSV: %s (per-row status is written here)", status_path)
    log.info("Log file:   %s", log_path)
    log.info("Profile:    %s", profile_dir)
    log.info("Subreddit column detected: '%s'", sub_col)
    log.info("Total rows: %d", len(rows))
    log.info("System: %.0f MB RAM available, %.0f MB disk free",
             get_available_ram_mb(), get_disk_free_mb(str(csv_path.parent)))

    # Log full system health at startup — this will help diagnose what's
    # actually causing the Pi to become unresponsive over time.
    log_system_health("startup")

    # Kill any orphaned Chromium processes from a previous run that crashed.
    # This prevents zombie processes from accumulating and consuming RAM.
    kill_orphaned_chromium()

    # Rotate the log file if it's gotten too large
    rotate_log_if_needed(log_path)

    if args.reprocess_failed:
        reset = 0
        for row in rows:
            if (row.get(STATUS_COL) or "").strip() in RETRYABLE_STATUSES:
                row[STATUS_COL] = "pending"
                row[ERROR_COL]  = ""
                reset += 1
        log.info("Reset %d 'failed'/'shadowbanned' row(s) back to 'pending'.", reset)
        # Write the reset state immediately so the dashboard reflects it
        # before the subscribe pass starts.
        write_csv_atomic(status_path, fieldnames, rows)

    session = BrowserSession(profile_dir=profile_dir, headless=args.headless)
    try:
        session.start()
        username = session.ensure_logged_in(force_login_prompt=args.force_login)

        if not args.verify_only:
            # Pass status_path (NOT csv_path) as the file to write to.
            run_subscribe_pass(session, username, status_path, sub_col, fieldnames, rows,
                               max_subscribes=args.max_subscribes)

        if not args.subscribe_only:
            run_verify_pass(session, status_path, sub_col, fieldnames, rows)

        log.info("Done. Status CSV: %s", status_path)
        log.info("Input CSV was NOT modified: %s", csv_path)
    finally:
        try:
            session.close()
        except Exception:
            pass
        # Kill any Chromium processes that didn't shut down cleanly.
        # This is critical on the Pi — orphaned Chromium processes
        # accumulate RAM and eventually trigger the OOM killer, which
        # takes down pi-hole, sshd, and other critical services.
        kill_orphaned_chromium()
        log.info("Cleanup complete. RAM available: %.0f MB", get_available_ram_mb())
        log_system_health("exit")


if __name__ == "__main__":
    main()
