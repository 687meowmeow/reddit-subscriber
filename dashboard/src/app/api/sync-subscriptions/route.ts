import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { spawn } from "child_process";
import path from "path";
import fsSync from "fs";

// ============================================================
// Sync subscriptions — fetch the user's LIVE subscribed subreddit
// list from Reddit and add any missing ones to the CSV.
//
// This lets you subscribe to subreddits manually on Reddit and
// have them automatically appear in your CSV.
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

// Python script that fetches the subscribed subreddit list
const FETCH_SCRIPT = `
import json
import sys
import urllib.request

# Fetch /subreddits/mine/.json with the browser profile's cookies.
# We use the Playwright browser profile's cookies by launching the
# browser and reading them — this is the most reliable way since
# the user is already logged in.
try:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch_persistent_context(
            user_data_dir="/root/.reddit_subscriber_profile",
            headless=True,
        )
        page = browser.new_page()
        page.goto("https://www.reddit.com/subreddits/mine/.json?limit=100", 
                  wait_until="domcontentloaded", timeout=30000)
        
        # Wait for the JSON to load
        import time
        time.sleep(2)
        
        # Get the page content (JSON text)
        content = page.inner_text("body")
        
        # Parse the JSON
        data = json.loads(content)
        
        subreddits = []
        after = None
        # Handle pagination via the JSON's "after" field
        while True:
            children = data.get("data", {}).get("children", [])
            for child in children:
                d = child.get("data", {})
                subreddits.append({
                    "name": d.get("display_name", ""),
                    "url": d.get("url", ""),
                    "is_nsfw": d.get("over18", False),
                })
            after = data.get("data", {}).get("after")
            if not after:
                break
            # Fetch next page
            page.goto(f"https://www.reddit.com/subreddits/mine/.json?limit=100&after={after}",
                      wait_until="domcontentloaded", timeout=30000)
            time.sleep(2)
            content = page.inner_text("body")
            data = json.loads(content)
        
        browser.close()
        
        # Output as JSON
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

    // Run the Python script
    const result = await new Promise<{ ok: boolean; subreddits?: any[]; error?: string }>(
      (resolve, reject) => {
        const child = spawn(pythonCmd, [scriptPath], {
          cwd: csvRoot,
          env: { ...process.env, PYTHONUNBUFFERED: "1" },
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (data) => { stdout += data.toString(); });
        child.stderr.on("data", (data) => { stderr += data.toString(); });

        // 2-minute timeout (fetching multiple pages takes time)
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Fetch script timed out after 2 minutes"));
        }, 120000);

        child.on("exit", (code) => {
          clearTimeout(timeout);
          try {
            // Parse the last line of stdout (JSON output)
            const lines = stdout.trim().split("\n");
            const lastLine = lines[lines.length - 1];
            const data = JSON.parse(lastLine);
            resolve(data);
          } catch (e) {
            reject(new Error(`Failed to parse script output: ${stdout.slice(-500)} | stderr: ${stderr.slice(-200)}`));
          }
        });
      }
    );

    // Clean up the temp script
    try { await fs.unlink(scriptPath); } catch {}

    if (!result.ok) {
      return NextResponse.json(
        { error: `Failed to fetch subscriptions: ${result.error}` },
        { status: 500 }
      );
    }

    const liveSubs: Array<{ name: string; is_nsfw: boolean }> = result.subreddits || [];

    if (liveSubs.length === 0) {
      return NextResponse.json({
        ok: true,
        message: "No subscribed subreddits found on Reddit",
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
        message: "All subscribed subreddits are already in the CSV",
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
      added_names: missing.slice(0, 10).map((s) => s.name),  // show first 10
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Sync failed: ${message}` },
      { status: 500 }
    );
  }
}
