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

    # Try to import playwright-stealth (the main subscriber script uses this).
    stealth = None
    try:
        from playwright_stealth import Stealth
        stealth = Stealth()
    except ImportError:
        log_diag("stealth_apply", "", 0, "",
                 "playwright-stealth NOT installed — Reddit likely detects bot", False, 0)

    subreddits = []

    with sync_playwright() as p:
        # CRITICAL: same launch config as the main subscriber script.
        #   - --disable-blink-features=AutomationControlled removes
        #     navigator.webdriver=true
        #   - playwright-stealth patches dozens of other bot signals
        #   - java_script_enabled MUST be True — Reddit detects JS-disabled
        launch_args = [
            "--disable-blink-features=AutomationControlled",
            "--no-first-run",
            "--no-default-browser-check",
        ]
        browser = p.chromium.launch_persistent_context(
            user_data_dir=profile_dir,
            headless=True,
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
                         "playwright-stealth applied successfully", False, 0)
            except Exception as exc:
                log_diag("stealth_apply", "", 0, "",
                         f"stealth apply failed: {exc}", False, 0)
        elif not diagnostics:
            log_diag("stealth_apply", "", 0, "",
                     "playwright-stealth NOT installed", False, 0)

        page = browser.new_page()
        page.set_extra_http_headers({
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
        })

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
                response = page.goto(url, wait_until="domcontentloaded", timeout=45000)
            except Exception as exc:
                log_diag(f"fetch_page_{page_count}", url, 0, "",
                         f"navigation error: {exc}", False, int((time.time()-t0)*1000))
                print(json.dumps({
                    "ok": True,
                    "subreddits": subreddits,
                    "warning": f"Network error on page {page_count}: {exc}",
                    "diagnostics": diagnostics,
                }))
                sys.exit(0)

            status = response.status if response else 0
            content_type = ""
            if response:
                try:
                    content_type = response.headers.get("content-type", "")
                except Exception:
                    pass

            try:
                body = response.text()
            except Exception as exc:
                log_diag(f"fetch_page_{page_count}", url, status, content_type,
                         f"could not read body: {exc}", False, int((time.time()-t0)*1000))
                browser.close()
                print(json.dumps({
                    "ok": False,
                    "error": f"Could not read response body: {exc}",
                    "diagnostics": diagnostics,
                }))
                sys.exit(0)

            stripped = body.lstrip()[:200]
            is_json = stripped.startswith("{") or stripped.startswith("[")

            if status == 401 or status == 403:
                snippet = body.replace("\\n", " ").strip()[:160]
                log_diag(f"fetch_page_{page_count}", url, status, content_type,
                         snippet, is_json, int((time.time()-t0)*1000))
                browser.close()
                print(json.dumps({
                    "ok": False,
                    "error": (
                        f"Reddit returned HTTP {status} — your browser profile "
                        f"is not authenticated OR Reddit detected the browser as "
                        f"a bot. Make sure playwright-stealth is installed "
                        f"(pip install playwright-stealth) and you've logged in "
                        f"via a normal subscriber run. Body snippet: {snippet}"
                    ),
                    "diagnostics": diagnostics,
                }))
                sys.exit(0)

            if status != 200:
                snippet = body.replace("\\n", " ").strip()[:160]
                log_diag(f"fetch_page_{page_count}", url, status, content_type,
                         snippet, is_json, int((time.time()-t0)*1000))
                browser.close()
                print(json.dumps({
                    "ok": False,
                    "error": (
                        f"Reddit returned HTTP {status} when fetching the "
                        f"subscriptions list. Body: {snippet}"
                    ),
                    "diagnostics": diagnostics,
                }))
                sys.exit(0)

            if not is_json:
                snippet = body.replace("\\n", " ").strip()[:160]
                log_diag(f"fetch_page_{page_count}", url, status, content_type,
                         snippet, False, int((time.time()-t0)*1000))
                browser.close()
                print(json.dumps({
                    "ok": False,
                    "error": (
                        f"Reddit returned HTML instead of JSON. This usually "
                        f"means you got rate-limited or logged out. Snippet: {snippet}"
                    ),
                    "diagnostics": diagnostics,
                }))
                sys.exit(0)

            try:
                data = json.loads(body)
                log_diag(f"fetch_page_{page_count}", url, status, content_type,
                         stripped[:200], True, int((time.time()-t0)*1000))
            except Exception as exc:
                log_diag(f"fetch_page_{page_count}", url, status, content_type,
                         f"json parse failed: {exc}", False, int((time.time()-t0)*1000))
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
