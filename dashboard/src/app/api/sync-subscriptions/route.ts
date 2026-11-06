import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { spawn } from "child_process";
import path from "path";
import fsSync from "fs";
import logger from "@/lib/logger";

// ============================================================
// Sync subscriptions — fetch the user's LIVE subscribed subreddit
// list from Reddit and add any missing ones to the CSV.
//
// POST /api/sync-subscriptions
// Body: { csv: "subscribed_subreddits.status.csv" }
//
// CRITICAL FIX (previous version always failed silently):
//   Same issue as Find Similar — the inline Python script was
//   missing playwright-stealth + AutomationControlled launch flag,
//   AND had java_script_enabled=False (a bot-detection red flag).
//   Reddit 403'd the /subreddits/mine/.json endpoint even when
//   the user was authenticated. Now we use the SAME stealth
//   configuration as the main subscriber script.
//
// BEHAVIOR CHANGE per user request:
//   Previously new subs were added with status="already_subscribed".
//   The user said: "i want it to also be marked as a new one."
//   Now new subs are added with status="pending" — they show up
//   in the Pending count on the dashboard, the script will process
//   them (verifying they're actually subscribed), and they get
//   a first_seen_at timestamp so they can be marked with a "New"
//   badge in the UI for 24 hours.
// ============================================================

async function getConfig(): Promise<any> {
  const configFile = path.join(process.cwd(), ".config.json");
  try {
    const data = await fs.readFile(configFile, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

// Python script — uses playwright-stealth + AutomationControlled flag
// to bypass Reddit's bot detection. Captures diagnostics for each
// HTTP request so failures can be debugged from /logs.
const FETCH_SCRIPT = `
import json
import sys
import os
import shutil
import subprocess
import time
from pathlib import Path

diagnostics = []

def log_diag(step, url, status, content_type, body_snippet, is_json, duration_ms):
    diagnostics.append({
        "step": step,
        "url": url,
        "status": status,
        "content_type": content_type or "",
        "body_snippet": (body_snippet or "")[:200],
        "is_json": is_json,
        "duration_ms": duration_ms,
    })

def find_display():
    """Find an available X display — same logic as the main subscriber."""
    display = os.environ.get("DISPLAY")
    if display:
        try:
            subprocess.run(["xset", "q"], env={**os.environ, "DISPLAY": display},
                          timeout=3, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            return display, "existing DISPLAY env"
        except Exception:
            pass
    for d in range(1, 6):
        candidate = f":{d}"
        try:
            subprocess.run(["xset", "q"], env={**os.environ, "DISPLAY": candidate},
                          timeout=3, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            return candidate, f"VNC display {candidate}"
        except Exception:
            pass
    xvfb = shutil.which("Xvfb")
    if xvfb:
        try:
            subprocess.run(["pkill", "-f", "Xvfb :99"], timeout=2,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass
        try:
            subprocess.Popen([xvfb, ":99", "-screen", "0", "1920x1080x24", "-ac",
                            "+extension", "RANDR"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(20):
                try:
                    subprocess.run(["xset", "q"], env={**os.environ, "DISPLAY": ":99"},
                                  timeout=1, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
                    return ":99", "Xvfb :99 (started by helper)"
                except Exception:
                    time.sleep(0.2)
        except Exception:
            pass
    return None, "headless (no display available)"

try:
    from playwright.sync_api import sync_playwright

    profile_dir = os.environ.get("REDDIT_PROFILE_DIR") or str(
        Path.home() / ".reddit_subscriber_profile"
    )
    if not os.path.isdir(profile_dir):
        print(json.dumps({
            "ok": False,
            "error": (
                f"Browser profile not found at {profile_dir}. Start a normal "
                f"subscriber run first so the browser saves your login cookies."
            ),
            "diagnostics": diagnostics,
        }))
        sys.exit(0)

    stealth = None
    try:
        from playwright_stealth import Stealth
        stealth = Stealth()
    except ImportError:
        log_diag("stealth_status", "", 0, "",
                 "playwright-stealth NOT installed", False, 0)

    display, display_method = find_display()
    use_headless = display is None

    log_diag("display_detection", "", 200 if display else 0, "",
             f"display={display}, method={display_method}, headless={use_headless}",
             False, 0)
    log_diag("stealth_status", "", 200 if stealth else 0, "",
             "playwright-stealth available" if stealth else "NOT installed", False, 0)

    subreddits = []

    with sync_playwright() as p:
        launch_args = [
            "--disable-blink-features=AutomationControlled",
            "--no-first-run",
            "--no-default-browser-check",
        ]
        browser = p.chromium.launch_persistent_context(
            user_data_dir=profile_dir,
            headless=use_headless,
            args=launch_args,
            viewport={"width": 1280, "height": 800},
            locale="en-US",
            timezone_id="America/Chicago",
            java_script_enabled=True,
        )

        if stealth is not None:
            try:
                stealth.apply_stealth_sync(browser)
                log_diag("stealth_apply", "", 200, "",
                         "playwright-stealth applied", False, 0)
            except Exception as exc:
                log_diag("stealth_apply", "", 0, "",
                         f"stealth apply failed: {exc}", False, 0)

        page = browser.new_page()
        # NOTE: Do NOT set Accept: application/json header.

        # --- STEP 1: Session warmup — navigate to reddit.com first ---
        t0 = time.time()
        try:
            response = page.goto("https://www.reddit.com/",
                               wait_until="domcontentloaded", timeout=30000)
            warmup_status = response.status if response else 0
            log_diag("session_warmup", "https://www.reddit.com/",
                     warmup_status, "",
                     f"navigated to reddit.com homepage",
                     False, int((time.time() - t0) * 1000))
        except Exception as exc:
            log_diag("session_warmup", "https://www.reddit.com/", 0, "",
                     f"navigation error: {exc}", False, int((time.time() - t0) * 1000))

        # Check login state
        try:
            logged_in_check = page.evaluate("""
                () => {
                    const body = document.body ? document.body.innerHTML : '';
                    const hasLoginButton = body.includes('Log In') || body.includes('"login"');
                    const hasUserMenu = body.includes('user-drawer') ||
                                       body.includes('"isLoggedIn":true');
                    const isLoggedOutShell = body.includes('theme-beta') && body.includes('"isLoggedOut":true');
                    return {
                        hasLoginButton: hasLoginButton,
                        hasUserMenu: hasUserMenu,
                        isLoggedOutShell: isLoggedOutShell,
                        url: window.location.href,
                    };
                }
            """)
            log_diag("login_check", "", 200, "text/html",
                     f"hasLoginButton={logged_in_check.get('hasLoginButton')}, "
                     f"hasUserMenu={logged_in_check.get('hasUserMenu')}, "
                     f"isLoggedOutShell={logged_in_check.get('isLoggedOutShell')}",
                     False, 0)

            if logged_in_check.get("isLoggedOutShell"):
                browser.close()
                print(json.dumps({
                    "ok": False,
                    "error": (
                        "Reddit shows the logged-out SPA shell. Your browser profile "
                        "is NOT authenticated. Start a normal subscriber run, log in "
                        "when prompted, wait for cookies to save, then try Sync again."
                    ),
                    "diagnostics": diagnostics,
                }))
                sys.exit(0)
        except Exception as exc:
            log_diag("login_check", "", 0, "",
                     f"evaluate error: {exc}", False, 0)

        page.wait_for_timeout(2000)

        # --- STEP 2: Fetch /subreddits/mine/.json via page.evaluate(fetch()) ---
        after = ""
        page_count = 0
        max_pages = 50

        while True:
            page_count += 1
            url = "https://www.reddit.com/subreddits/mine/.json?limit=100"
            if after:
                url += "&after=" + after

            t0 = time.time()
            try:
                result = page.evaluate("""
                    async (url) => {
                        try {
                            const res = await fetch(url, {
                                credentials: 'include',
                                headers: {'Accept': 'application/json'}
                            });
                            const status = res.status;
                            const ct = res.headers.get('content-type') || '';
                            const text = await res.text();
                            return {status: status, contentType: ct, body: text};
                        } catch (e) {
                            return {status: 0, contentType: '', body: '', error: String(e)};
                        }
                    }
                """, url)
            except Exception as exc:
                result = {"status": 0, "contentType": "", "body": "",
                         "error": f"evaluate error: {exc}"}

            status = result.get("status", 0)
            ct = result.get("contentType", "")
            body = result.get("body", "")
            stripped = body.lstrip()[:200] if body else ""
            is_json = stripped.startswith("{") or stripped.startswith("[")
            snippet = (stripped or result.get("error", ""))[:200]

            log_diag(f"fetch_page_{page_count}", url, status, ct,
                     snippet, is_json, int((time.time() - t0) * 1000))

            if status == 401 or status == 403:
                browser.close()
                print(json.dumps({
                    "ok": False,
                    "error": (
                        f"Reddit returned HTTP {status} for subscriptions list "
                        f"even after session warmup. Body: {snippet}"
                    ),
                    "diagnostics": diagnostics,
                }))
                sys.exit(0)

            if status != 200 or not is_json:
                browser.close()
                print(json.dumps({
                    "ok": False,
                    "error": (
                        f"Reddit returned HTTP {status} ({'JSON' if is_json else 'HTML'}) "
                        f"for subscriptions list. Body: {snippet}"
                    ),
                    "diagnostics": diagnostics,
                }))
                sys.exit(0)

            try:
                data = json.loads(body)
            except Exception as exc:
                browser.close()
                print(json.dumps({
                    "ok": False,
                    "error": f"Failed to parse JSON: {exc}",
                    "diagnostics": diagnostics,
                }))
                sys.exit(0)

            if not isinstance(data, dict):
                browser.close()
                print(json.dumps({
                    "ok": False,
                    "error": f"Unexpected response shape: {type(data).__name__}",
                    "diagnostics": diagnostics,
                }))
                sys.exit(0)

            children = data.get("data", {}).get("children", [])
            if not children:
                break

            for child in children:
                d = child.get("data", {}) if isinstance(child, dict) else {}
                name = d.get("display_name", "")
                if name:
                    subreddits.append({
                        "name": name,
                        "url": d.get("url", ""),
                        "is_nsfw": d.get("over18", False),
                    })

            after = data.get("data", {}).get("after", "")
            if not after:
                break
            if page_count >= max_pages:
                break

        browser.close()

    print(json.dumps({
        "ok": True,
        "subreddits": subreddits,
        "diagnostics": diagnostics,
        "display_used": display or "headless",
        "display_method": display_method,
    }))

except Exception as e:
    print(json.dumps({
        "ok": False,
        "error": f"Unexpected error: {type(e).__name__}: {e}",
        "diagnostics": diagnostics,
    }))
    sys.exit(0)
`;

export async function POST(request: NextRequest) {
  const routeName = "POST /api/sync-subscriptions";
  const startTime = Date.now();
  try {
    const body = await request.json().catch(() => ({}));
    const csvParam = body.csv;

    logger.info("Sync subscriptions request received", { csv: csvParam }, routeName);

    if (!csvParam) {
      logger.warn("Sync rejected — missing csv field", undefined, routeName);
      return NextResponse.json(
        { error: "Missing 'csv' field" },
        { status: 400 }
      );
    }

    const config = await getConfig();
    const csvRoot = config.csvRoot || path.resolve(process.cwd(), "..");
    const pythonCmd = config.pythonCmd || "python3";
    const resolvedPath = path.isAbsolute(csvParam)
      ? path.resolve(csvParam)
      : path.resolve(csvRoot, csvParam);

    if (!fsSync.existsSync(resolvedPath)) {
      return NextResponse.json(
        { error: `CSV file not found: ${resolvedPath}` },
        { status: 404 }
      );
    }

    // Write the fetch script to a temp file
    const scriptPath = path.join(csvRoot, ".fetch_subs_temp.py");
    await fs.writeFile(scriptPath, FETCH_SCRIPT, "utf-8");

    const profileDir = path.join(
      process.env.HOME || process.env.USERPROFILE || "/root",
      ".reddit_subscriber_profile"
    );

    const result = await new Promise<{ ok: boolean; subreddits?: any[]; error?: string; warning?: string; diagnostics?: any[] }>(
      (resolve, reject) => {
        const child = spawn(pythonCmd, [scriptPath], {
          cwd: csvRoot,
          env: {
            ...process.env,
            PYTHONUNBUFFERED: "1",
            REDDIT_PROFILE_DIR: profileDir,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (data) => { stdout += data.toString(); });
        child.stderr.on("data", (data) => { stderr += data.toString(); });

        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Fetch script timed out after 3 minutes. Try again — Reddit may be slow."));
        }, 180000);

        child.on("exit", (code) => {
          clearTimeout(timeout);
          try {
            const lines = stdout.trim().split("\n").filter((l) => l.trim());
            const lastLine = lines[lines.length - 1];
            if (!lastLine) {
              reject(new Error(
                `Fetch script produced no output. stdout: ${stdout.slice(-300)} | stderr: ${stderr.slice(-300)}`
              ));
              return;
            }
            const data = JSON.parse(lastLine);
            resolve(data);
          } catch (e) {
            reject(new Error(
              `Failed to parse script output: ${stdout.slice(-500)} | stderr: ${stderr.slice(-300)}`
            ));
          }
        });

        child.on("error", (err) => {
          clearTimeout(timeout);
          reject(new Error(`Failed to spawn Python: ${err.message}`));
        });
      }
    );

    try { await fs.unlink(scriptPath); } catch {}

    // Log diagnostics at DEBUG level so they're available in /logs
    const diagnostics = result.diagnostics || [];
    if (diagnostics.length > 0) {
      logger.debug("Sync diagnostics (per HTTP request)", {
        diagnostics_count: diagnostics.length,
        diagnostics_summary: diagnostics.map((d: any) => ({
          step: d.step,
          status: d.status,
          is_json: d.is_json,
          body_snippet: (d.body_snippet || "").slice(0, 120),
        })),
      }, routeName);
    }

    if (!result.ok) {
      logger.warn("Sync — Python helper returned error", {
        error: result.error,
        duration_ms: Date.now() - startTime,
        diagnostics_count: diagnostics.length,
      }, routeName);
      return NextResponse.json(
        { error: result.error || "Failed to fetch subscriptions", diagnostics: diagnostics.slice(0, 10) },
        { status: 500 }
      );
    }

    const liveSubs: Array<{ name: string; is_nsfw: boolean }> = result.subreddits || [];

    logger.info("Sync — fetched live subscriptions", {
      total_live: liveSubs.length,
      duration_ms: Date.now() - startTime,
    }, routeName);

    if (liveSubs.length === 0) {
      return NextResponse.json({
        ok: true,
        message: result.warning
          ? `No subscribed subreddits found. (${result.warning})`
          : "No subscribed subreddits found on Reddit",
        added: 0,
        total_live: 0,
        diagnostics: diagnostics.slice(0, 10),
      });
    }

    // Read the CSV and find missing subreddits
    const text = await fs.readFile(resolvedPath, "utf-8");
    const lines = text.split("\n").filter((l) => l.trim());

    // Parse header to find the subreddit column index
    const headerLine = lines[0];
    const fieldnames = headerLine.split(",").map((f) => f.trim().replace(/^"|"$/g, ""));
    let subColIdx = 0;
    const SUB_NAMES = ["subreddit", "subreddit_name", "sub", "name", "sr"];
    for (const col of SUB_NAMES) {
      const idx = fieldnames.findIndex((f) => f.toLowerCase() === col);
      if (idx >= 0) { subColIdx = idx; break; }
    }

    // Build a set of subreddit names already in the CSV
    const existingNames = new Set<string>();
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      const name = (cols[subColIdx] || "").toLowerCase().replace(/^"|"$/g, "").trim();
      if (name) existingNames.add(name);
    }

    // Find missing subreddits
    const missing = liveSubs.filter((s) => !existingNames.has(s.name.toLowerCase()));

    if (missing.length === 0) {
      logger.info("Sync — all subs already in CSV, nothing to add", {
        total_live: liveSubs.length,
      }, routeName);
      return NextResponse.json({
        ok: true,
        message: `All ${liveSubs.length} subscribed subreddits are already in the CSV`,
        added: 0,
        total_live: liveSubs.length,
        diagnostics: diagnostics.slice(0, 10),
      });
    }

    // Determine if we have a first_seen_at column — if not, ADD it.
    // first_seen_at tracks when each sub was added to the CSV, so the
    // dashboard can show a "New" badge for subs added in the last 24h.
    let finalFieldnames = [...fieldnames];
    let hasFirstSeenAt = fieldnames.some((f) => f.toLowerCase() === "first_seen_at");
    let needsHeaderRewrite = false;
    if (!hasFirstSeenAt) {
      finalFieldnames.push("first_seen_at");
      needsHeaderRewrite = true;
    }
    const firstSeenAtIdx = finalFieldnames.findIndex((f) => f.toLowerCase() === "first_seen_at");
    const nowIso = new Date().toISOString();

    function escapeCsvField(value: string): string {
      if (!value) return "";
      if (value.includes(",") || value.includes('"') || value.includes("\n")) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    }

    // Build new rows for missing subreddits.
    // BEHAVIOR CHANGE per user request:
    //   New subs are added with status="pending" (NOT "already_subscribed")
    //   so they:
    //     1. Show up in the Pending count on the dashboard (visible as "new")
    //     2. Get processed by the subscriber script (which will verify
    //        they're actually subscribed and mark them accordingly)
    //     3. Get a first_seen_at timestamp for the "New" badge
    const newLines = missing.map((s) => {
      const row = finalFieldnames.map((fn) => {
        const lower = fn.toLowerCase();
        if (lower === "subreddit" || lower === "subreddit_name" || lower === "sub" || lower === "name" || lower === "sr") {
          return escapeCsvField(s.name);
        }
        if (lower === "status") return "pending";  // CHANGED from "already_subscribed"
        if (lower === "is_nsfw") return s.is_nsfw ? "true" : "false";
        if (lower === "verified") return "verified";
        if (lower === "first_seen_at") return nowIso;
        if (lower === "subscribed_at") return nowIso;
        return "";
      });
      return row.join(",");
    });

    // Append to the CSV. If we added a first_seen_at column to the header,
    // we also need to rewrite the header line and pad existing rows with
    // an empty field so the column count matches.
    let newText: string;
    if (needsHeaderRewrite) {
      // Pad existing data rows with an extra empty cell for first_seen_at
      const paddedDataLines = lines.slice(1).map((line) => {
        const cells = line.split(",");
        while (cells.length < finalFieldnames.length - 1) cells.push("");
        // existing rows have no first_seen_at — leave empty
        return cells.join(",");
      });
      newText = finalFieldnames.map(escapeCsvField).join(",") + "\n" +
                paddedDataLines.join("\n") +
                (paddedDataLines.length > 0 ? "\n" : "") +
                newLines.join("\n") + "\n";
    } else {
      newText = text.endsWith("\n") ? text + newLines.join("\n") + "\n" : text + "\n" + newLines.join("\n") + "\n";
    }
    await fs.writeFile(resolvedPath, newText, "utf-8");

    logger.info("Sync complete — appended new subreddits to CSV as pending", {
      added: missing.length,
      total_live: liveSubs.length,
      added_names: missing.slice(0, 10).map((s) => s.name),
      marked_as: "pending",  // log the new behavior explicitly
      added_first_seen_at_column: needsHeaderRewrite,
      duration_ms: Date.now() - startTime,
    }, routeName);

    return NextResponse.json({
      ok: true,
      message: `Added ${missing.length} new subreddit(s) to the CSV as pending`,
      added: missing.length,
      total_live: liveSubs.length,
      added_names: missing.slice(0, 10).map((s) => s.name),
      warning: result.warning,
      marked_as: "pending",
      added_first_seen_at_column: needsHeaderRewrite,
      diagnostics: diagnostics.slice(0, 10),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Sync subscriptions failed", {
      error: message,
      duration_ms: Date.now() - startTime,
    }, routeName, err instanceof Error ? err.stack : undefined);
    return NextResponse.json(
      { error: `Sync failed: ${message}` },
      { status: 500 }
    );
  }
}
