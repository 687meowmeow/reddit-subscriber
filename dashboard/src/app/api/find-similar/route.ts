import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import fsSync from "fs";
import { spawn } from "child_process";
import logger from "@/lib/logger";

// ============================================================
// Find similar subreddits for a (typically banned) subreddit.
//
// POST /api/find-similar
// Body: { subreddit: "animepanties", csv: "subscribed_subreddits.status.csv" }
//
// CRITICAL CONTEXT (as of late May 2026):
//   Reddit killed unauthenticated .json endpoint access. Plain
//   fetch('https://www.reddit.com/r/NAME/about.json') now returns
//   403 Forbidden HTML. The ONLY way to get JSON from Reddit is via
//   an authenticated browser session.
//
//   We solve this by spawning a Python helper script
//   (find_similar_helper.py) that uses Playwright with the saved
//   browser profile (~/.reddit_subscriber_profile) — the same
//   profile the main subscriber script uses, so login cookies are
//   shared. This is the same approach that works for the
//   sync-subscriptions endpoint.
//
// Algorithm:
//   1. Spawn find_similar_helper.py with the subreddit name
//   2. Python fetches /r/NAME/about.json (gets description, subscribers)
//   3. Python extracts keywords from name + description
//   4. Python searches /subreddits/search.json?q=KEYWORDS (multiple
//      query strategies)
//   5. Python returns combined JSON
//   6. TS filters out private/quarantined/<100 subs
//   7. TS scores by keyword relevance + checks if already in CSV
//   8. Returns top 20 results
// ============================================================

async function getCsvRoot(): Promise<string> {
  const configFile = path.join(process.cwd(), ".config.json");
  try {
    const data = await fs.readFile(configFile, "utf-8");
    const config = JSON.parse(data);
    if (config.csvRoot) return config.csvRoot;
  } catch {}
  let current = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fsSync.existsSync(path.join(current, "reddit_browser_subscriber.py"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(process.cwd(), "..");
}

async function getConfig(): Promise<any> {
  const configFile = path.join(process.cwd(), ".config.json");
  try {
    const data = await fs.readFile(configFile, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

// Check if a subreddit is already in the user's CSV
async function isAlreadyInCsv(
  csvRoot: string,
  csvName: string | undefined,
  subredditName: string
): Promise<boolean> {
  if (!csvName) return false;
  const csvPath = path.isAbsolute(csvName) ? csvName : path.join(csvRoot, csvName);
  try {
    const text = await fs.readFile(csvPath, "utf-8");
    const normalizedName = subredditName.toLowerCase();
    return text.toLowerCase().includes(normalizedName);
  } catch {
    return false;
  }
}

interface SimilarSubreddit {
  name: string;
  display_name: string;
  subscribers: number;
  description: string;
  is_nsfw: boolean;
  relevance_score: number;
  already_in_csv: boolean;
  url: string;
}

interface HelperResult {
  ok: boolean;
  subreddit?: string;
  display_name?: string;
  description?: string;
  subscribers?: number;
  is_nsfw?: boolean;
  is_banned?: boolean;
  is_private?: boolean;
  keywords?: string[];
  search_results?: Array<{
    name: string;
    display_name: string;
    subscribers: number;
    description: string;
    is_nsfw: boolean;
    is_quarantined: boolean;
    subreddit_type: string;
    url: string;
  }>;
  queries_used?: string[];
  error?: string;
}

// Spawn the Python helper and return its parsed JSON output
async function runPythonHelper(
  pythonCmd: string,
  scriptPath: string,
  csvRoot: string,
  subreddit: string
): Promise<HelperResult> {
  const profileDir = path.join(
    process.env.HOME || process.env.USERPROFILE || "/root",
    ".reddit_subscriber_profile"
  );

  return new Promise<HelperResult>((resolve, reject) => {
    const child = spawn(
      pythonCmd,
      [scriptPath, "--subreddit", subreddit, "--csv-root", csvRoot],
      {
        cwd: csvRoot,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          REDDIT_PROFILE_DIR: profileDir,
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    // 90-second timeout — multiple Reddit fetches + search
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      logger.warn("Python helper timed out", {
        subreddit,
        stdout_length: stdout.length,
        stderr_tail: stderr.slice(-300),
      }, "POST /api/find-similar");
      reject(new Error("Find Similar script timed out after 90 seconds. Reddit may be slow or rate-limiting."));
    }, 90000);

    child.on("exit", (code) => {
      clearTimeout(timeout);
      try {
        // Parse the LAST line of stdout (JSON output)
        const lines = stdout.trim().split("\n").filter((l) => l.trim());
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          logger.error("Python helper produced no output", {
            subreddit,
            code,
            stdout_tail: stdout.slice(-500),
            stderr_tail: stderr.slice(-500),
          }, "POST /api/find-similar");
          reject(new Error(
            `Find Similar script produced no output. stderr: ${stderr.slice(-300)}`
          ));
          return;
        }
        const data = JSON.parse(lastLine) as HelperResult;
        logger.debug("Python helper exited", {
          subreddit,
          exit_code: code,
          ok: data.ok,
          results_count: data.search_results?.length || 0,
          stderr_lines: stderr.split("\n").filter(l => l.trim()).length,
        }, "POST /api/find-similar");
        resolve(data);
      } catch (e) {
        logger.error("Failed to parse Python helper output", {
          subreddit,
          error: e instanceof Error ? e.message : String(e),
          stdout_tail: stdout.slice(-500),
          stderr_tail: stderr.slice(-300),
        }, "POST /api/find-similar");
        reject(new Error(
          `Failed to parse Find Similar script output: ${stdout.slice(-500)} | stderr: ${stderr.slice(-300)}`
        ));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      logger.error("Failed to spawn Python helper", {
        subreddit,
        error: err.message,
        pythonCmd,
        scriptPath,
      }, "POST /api/find-similar");
      reject(new Error(`Failed to spawn Python helper: ${err.message}`));
    });
  });
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const routeName = "POST /api/find-similar";
  const body = await request.json().catch(() => ({}));
  const subredditName = (body.subreddit || "").trim();
  const csvName = body.csv;

  logger.info("Find Similar request received", {
    subreddit: subredditName,
    csv: csvName,
  }, routeName);

  if (!subredditName) {
    logger.warn("Missing subreddit field in request", undefined, routeName);
    return NextResponse.json(
      { error: "Missing 'subreddit' field" },
      { status: 400 }
    );
  }

  // Strip r/ prefix
  const cleanName = subredditName.replace(/^r\//i, "").replace(/^\/r\//i, "");

  // Reject user profiles
  if (cleanName.toLowerCase().startsWith("u_") || cleanName.toLowerCase().startsWith("u/")) {
    logger.warn("Rejected user profile (Find Similar only works for subreddits)", {
      subreddit: cleanName,
    }, routeName);
    return NextResponse.json(
      {
        error: `"${cleanName}" looks like a user profile (u_ prefix). Find Similar only works for subreddits, not user accounts.`,
      },
      { status: 400 }
    );
  }

  const config = await getConfig();
  const csvRoot = config.csvRoot || path.resolve(process.cwd(), "..");
  const pythonCmd = config.pythonCmd || "python3";
  const scriptPath = path.join(csvRoot, "find_similar_helper.py");

  if (!fsSync.existsSync(scriptPath)) {
    logger.error("find_similar_helper.py not found", {
      expected_path: scriptPath,
      csvRoot,
    }, routeName);
    return NextResponse.json(
      {
        error: `Find Similar helper script not found at: ${scriptPath}. Make sure your CSV root is set correctly.`,
      },
      { status: 500 }
    );
  }

  // Run the Python helper
  let helperResult: HelperResult;
  try {
    helperResult = await runPythonHelper(pythonCmd, scriptPath, csvRoot, cleanName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Python helper execution failed", {
      subreddit: cleanName,
      error: msg,
      duration_ms: Date.now() - startTime,
    }, routeName);
    return NextResponse.json(
      { error: `Find Similar failed: ${msg}` },
      { status: 500 }
    );
  }

  if (!helperResult.ok) {
    logger.warn("Python helper returned error", {
      subreddit: cleanName,
      error: helperResult.error,
      duration_ms: Date.now() - startTime,
    }, routeName);
    return NextResponse.json(
      { error: helperResult.error || "Find Similar failed" },
      { status: 500 }
    );
  }

  const keywords = helperResult.keywords || [];
  const rawResults = helperResult.search_results || [];

  logger.info("Python helper succeeded", {
    subreddit: cleanName,
    keywords,
    raw_results_count: rawResults.length,
    queries_used: helperResult.queries_used,
    duration_ms: Date.now() - startTime,
  }, routeName);

  // Score and filter results
  const results: SimilarSubreddit[] = [];
  const seen = new Set<string>();

  for (const sub of rawResults) {
    const name = sub.name || "";
    if (!name || name.toLowerCase() === cleanName.toLowerCase()) continue;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());

    // Skip private/quarantined (extra safety; Python already filters these)
    if ((sub.subreddit_type || "").toLowerCase() === "private") continue;
    if (sub.is_quarantined) continue;
    if (sub.subscribers < 100) continue;

    // Calculate relevance score based on keyword overlap
    const subNameLower = name.toLowerCase();
    const subDescLower = (sub.description || "").toLowerCase();
    let relevanceScore = 0;
    for (const kw of keywords) {
      if (subNameLower.includes(kw)) relevanceScore += 3;
      if (subDescLower.includes(kw)) relevanceScore += 1;
    }

    // Check if already in CSV
    const alreadyInCsv = await isAlreadyInCsv(csvRoot, csvName, name);

    results.push({
      name,
      display_name: sub.display_name || name,
      subscribers: sub.subscribers,
      description: sub.description || "",
      is_nsfw: sub.is_nsfw,
      relevance_score: relevanceScore,
      already_in_csv: alreadyInCsv,
      url: sub.url || `https://www.reddit.com/r/${name}`,
    });
  }

  // Sort by relevance score (then by subscribers)
  results.sort((a, b) => {
    if (b.relevance_score !== a.relevance_score) {
      return b.relevance_score - a.relevance_score;
    }
    return b.subscribers - a.subscribers;
  });

  // Return top 25 (was 20; bumped because Reddit's search is less precise)
  const topResults = results.slice(0, 25);

  logger.info("Find Similar complete", {
    subreddit: cleanName,
    keywords,
    final_results_count: topResults.length,
    duration_ms: Date.now() - startTime,
  }, routeName);

  return NextResponse.json({
    subreddit: cleanName,
    display_name: helperResult.display_name || cleanName,
    description: helperResult.description || "",
    keywords,
    is_banned: helperResult.is_banned || false,
    is_private: helperResult.is_private || false,
    results: topResults,
    total_found: results.length,
    queries_used: helperResult.queries_used || [],
  });
}
