import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { spawn } from "child_process";
import path from "path";
import fsSync from "fs";

// ============================================================
// Sync subscriptions — fetch the user's LIVE subscribed subreddit
// list from Reddit and add any missing ones to the CSV.
//
// POST /api/sync-subscriptions
// Body: { csv: "subscribed_subreddits.status.csv" }
//
// How it works:
// 1. Runs a small Python script that uses the browser profile's
//    cookies to fetch /subreddits/mine/.json (paginated)
// 2. Gets the full list of subreddits the account is subscribed to
// 3. Compares with the CSV
// 4. Adds missing subreddits to the CSV as "already_subscribed"
//    (so the script skips them on the next run)
//
// IMPORTANT — previous bug:
//   The old script used `page.inner_text("body")` after navigating
//   to the JSON URL. Reddit serves JSON URLs in two ways:
//     - When authenticated + JSON Accept header → raw JSON
//     - When not authenticated or HTML Accept header → HTML page
//       (login redirect, rate-limit "Whoa there pardner", etc.)
//   `inner_text("body")` would return the rendered text of that
//   HTML page (e.g. "Whoa there, pardner!..."), which then failed
//   `json.loads()` with "Expecting value: line 1 column 1 (char 0)".
//
//   Fix: use `response.text()` (raw HTTP body), check the HTTP
//   status code, and detect HTML responses before trying to parse.
//   This is the SAME approach that already works in the main
//   subscriber script's `fetch_subscribed_subreddits()` function.
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

// Python script that fetches the subscribed subreddit list.
// Uses the same Playwright persistent context as the main subscriber
// so cookies (login state) are shared.
const FETCH_SCRIPT = `
import json
import sys
import os
from pathlib import Path

# ============================================================
# Fetch /subreddits/mine/.json with the browser profile's cookies.
# We use the Playwright browser profile (the SAME one the main
# subscriber script uses) so cookies / login state are shared.
# This means if you've logged in once via the main script, this
# fetch will be authenticated.
# ============================================================

try:
    from playwright.sync_api import sync_playwright
    from playwright._impl._errors import Error as PlaywrightError

    # Locate the browser profile dir — same default as the main script.
    profile_dir = os.environ.get("REDDIT_PROFILE_DIR") or str(
        Path.home() / ".reddit_subscriber_profile"
    )

    subreddits = []

    with sync_playwright() as p:
        # launch_persistent_context loads the saved cookies (login state).
        browser = p.chromium.launch_persistent_context(
            user_data_dir=profile_dir,
            headless=True,
            # Match the main script's user agent so Reddit doesn't see
            # a different browser fingerprint on this fetch.
            user_agent=(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 800},
            java_script_enabled=False,  # we only need the raw JSON body
        )
        page = browser.new_page()

        # Set Accept header to application/json so Reddit returns raw JSON
        # instead of an HTML wrapper page.
        page.set_extra_http_headers({
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
        })

        after = ""
        page_count = 0
        max_pages = 50  # safety cap — Reddit caps at ~100 subs/page

        while True:
            page_count += 1
            url = "https://www.reddit.com/subreddits/mine/.json?limit=100"
            if after:
                url += "&after=" + after

            try:
                response = page.goto(url, wait_until="domcontentloaded", timeout=45000)
            except Exception as exc:
                # Network error — abort with what we have so far
                print(json.dumps({
                    "ok": True,
                    "subreddits": subreddits,
                    "warning": f"Network error on page {page_count}: {exc}",
                }))
                sys.exit(0)

            status = response.status if response else 0
            if status == 401 or status == 403:
                # Not logged in — the profile's cookies are gone/expired.
                browser.close()
                print(json.dumps({
                    "ok": False,
                    "error": (
                        f"Reddit returned HTTP {status} — you are not logged "
                        f"in. Start a normal subscriber run first so the "
                        f"browser profile saves your login cookies, then "
                        f"try Sync again."
                    ),
                }))
                sys.exit(1)

            if status != 200:
                browser.close()
                print(json.dumps({
                    "ok": False,
                    "error": (
                        f"Reddit returned HTTP {status} when fetching the "
                        f"subscriptions list. Try again in a moment."
                    ),
                }))
                sys.exit(1)

            # Grab the RAW HTTP body — NOT inner_text("body"), which
            # would return the rendered HTML text (fails json.loads).
            try:
                body = response.text()
            except Exception as exc:
                browser.close()
                print(json.dumps({
                    "ok": False,
                    "error": f"Could not read response body: {exc}",
                }))
                sys.exit(1)

            # Detect HTML responses (login page, rate-limit page, etc.)
            # — these would fail json.loads with a confusing error.
            stripped = body.lstrip()[:200]
            if not stripped.startswith("{") and not stripped.startswith("["):
                browser.close()
                # Extract a short snippet for debugging
                snippet = body.strip().replace("\\n", " ")[:160]
                print(json.dumps({
                    "ok": False,
                    "error": (
                        f"Reddit returned HTML instead of JSON. This usually "
                        f"means you got rate-limited or logged out. "
                        f"Snippet: {snippet}"
                    ),
                }))
                sys.exit(1)

            try:
                data = json.loads(body)
            except Exception as exc:
                browser.close()
                print(json.dumps({
                    "ok": False,
                    "error": f"Failed to parse JSON: {exc}",
                }))
                sys.exit(1)

            if not isinstance(data, dict):
                browser.close()
                print(json.dumps({
                    "ok": False,
                    "error": f"Unexpected response shape: {type(data).__name__}",
                }))
                sys.exit(1)

            children = data.get("data", {}).get("children", [])
            if not children:
                # No more subs — end of pagination
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
                break  # end of pagination
            if page_count >= max_pages:
                break  # safety cap

        browser.close()

    print(json.dumps({"ok": True, "subreddits": subreddits}))

except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
    sys.exit(1)
`;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const csvParam = body.csv;

    if (!csvParam) {
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

    // Run the Python script. Pass REDDIT_PROFILE_DIR explicitly so the
    // script picks up the same profile as the main subscriber.
    const profileDir = path.join(
      process.env.HOME || process.env.USERPROFILE || "/root",
      ".reddit_subscriber_profile"
    );

    const result = await new Promise<{ ok: boolean; subreddits?: any[]; error?: string; warning?: string }>(
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

        // 3-minute timeout — paginating through 1000+ subs takes time
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Fetch script timed out after 3 minutes. Try again — Reddit may be slow."));
        }, 180000);

        child.on("exit", (code) => {
          clearTimeout(timeout);
          try {
            // Parse the LAST line of stdout (JSON output).
            // The script may print Playwright warnings on stderr but
            // only one JSON line on stdout.
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

    // Clean up the temp script
    try { await fs.unlink(scriptPath); } catch {}

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error || "Failed to fetch subscriptions" },
        { status: 500 }
      );
    }

    const liveSubs: Array<{ name: string; is_nsfw: boolean }> = result.subreddits || [];

    if (liveSubs.length === 0) {
      return NextResponse.json({
        ok: true,
        message: result.warning
          ? `No subscribed subreddits found. (${result.warning})`
          : "No subscribed subreddits found on Reddit",
        added: 0,
        total_live: 0,
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
      return NextResponse.json({
        ok: true,
        message: `All ${liveSubs.length} subscribed subreddits are already in the CSV`,
        added: 0,
        total_live: liveSubs.length,
      });
    }

    // Build new rows for missing subreddits
    function escapeCsvField(value: string): string {
      if (!value) return "";
      if (value.includes(",") || value.includes('"') || value.includes("\n")) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    }

    const newLines = missing.map((s) => {
      const row = fieldnames.map((fn) => {
        const lower = fn.toLowerCase();
        if (lower === "subreddit" || lower === "subreddit_name" || lower === "sub" || lower === "name" || lower === "sr") {
          return escapeCsvField(s.name);
        }
        if (lower === "status") return "already_subscribed";
        if (lower === "is_nsfw") return s.is_nsfw ? "true" : "false";
        if (lower === "verified") return "verified";
        return "";
      });
      return row.join(",");
    });

    // Append to the CSV
    const newText = text.endsWith("\n") ? text + newLines.join("\n") + "\n" : text + "\n" + newLines.join("\n") + "\n";
    await fs.writeFile(resolvedPath, newText, "utf-8");

    return NextResponse.json({
      ok: true,
      message: `Added ${missing.length} subreddit(s) to the CSV`,
      added: missing.length,
      total_live: liveSubs.length,
      added_names: missing.slice(0, 10).map((s) => s.name),
      warning: result.warning,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Sync failed: ${message}` },
      { status: 500 }
    );
  }
}
