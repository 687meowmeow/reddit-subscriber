import { NextRequest, NextResponse } from "next/server";
import { spawn, execSync, ChildProcess } from "child_process";
import path from "path";
import { promises as fs } from "fs";
import fsSync from "fs";

// ============================================================
// Display detection — ensures Chromium can open a window even
// when the Pi boots without a desktop session running.
//
// Priority:
//   1. Use existing DISPLAY env var if the X server is reachable
//   2. Detect a running VNC server (:1, :2, ...) and use that
//   3. Start Xvfb on :99 as a virtual display fallback
//
// We do NOT auto-start TigerVNC because it requires a password
// to be configured and may prompt interactively. Xvfb is safe to
// start non-interactively.
// ============================================================

function xServerReachable(display: string): boolean {
  try {
    // Check if we can list windows on this display via xset
    execSync(`DISPLAY=${display} xset q`, {
      timeout: 3000,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function findVncDisplay(): string | null {
  // TigerVNC and RealVNC create displays :1, :2, etc.
  // Check if any of these are running and reachable.
  for (let d = 1; d <= 5; d++) {
    const display = `:${d}`;
    if (xServerReachable(display)) {
      return display;
    }
  }
  return null;
}

function startXvfb(): string | null {
  // Start a virtual framebuffer on display :99.
  // This lets Chromium run in headed mode without a physical monitor
  // or VNC server. The user won't see the browser window, but it won't
  // be headless (which would increase shadowban risk).
  try {
    // Kill any existing Xvfb on :99
    try {
      execSync("pkill -f 'Xvfb :99'", { stdio: "ignore", timeout: 2000 });
    } catch {}
    // Start Xvfb with a reasonable resolution
    execSync(
      "Xvfb :99 -screen 0 1920x1080x24 -ac &",
      { stdio: "ignore", timeout: 5000, detached: true }
    );
    // Wait a moment for it to start
    setTimeout(() => {}, 1000);
    // Verify it's running
    if (xServerReachable(":99")) {
      return ":99";
    }
    return null;
  } catch {
    return null;
  }
}

function ensureDisplay(): { display: string; method: string } | null {
  // 1. Check if DISPLAY is already set and reachable
  const currentDisplay = process.env.DISPLAY;
  if (currentDisplay && xServerReachable(currentDisplay)) {
    return { display: currentDisplay, method: "existing DISPLAY" };
  }

  // 2. Check for a running VNC server
  const vncDisplay = findVncDisplay();
  if (vncDisplay) {
    return { display: vncDisplay, method: "VNC server detected" };
  }

  // 3. Start Xvfb as a fallback
  const xvfbDisplay = startXvfb();
  if (xvfbDisplay) {
    return { display: xvfbDisplay, method: "Xvfb virtual display started" };
  }

  return null;
}

// ============================================================
// Read config from .config.json
// ============================================================
async function getConfig(): Promise<{
  csvRoot: string;
  pythonCmd: string;
  redditUsername?: string;
  redditPassword?: string;
}> {
  const configFile = path.join(process.cwd(), ".config.json");
  try {
    const data = await fs.readFile(configFile, "utf-8");
    const config = JSON.parse(data);
    return {
      csvRoot: config.csvRoot || "",
      pythonCmd: config.pythonCmd || (process.platform === "win32" ? "python" : "python3"),
      redditUsername: config.redditUsername,
      redditPassword: config.redditPassword,
    };
  } catch {
    // Auto-detect
    let current = process.cwd();
    for (let i = 0; i < 10; i++) {
      if (fsSync.existsSync(path.join(current, "reddit_browser_subscriber.py"))) {
        return {
          csvRoot: current,
          pythonCmd: process.platform === "win32" ? "python" : "python3",
        };
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return {
      csvRoot: path.resolve(process.cwd(), ".."),
      pythonCmd: process.platform === "win32" ? "python" : "python3",
    };
  }
}

interface RunState {
  process: ChildProcess | null;
  pid: number | null;
  status: "idle" | "running" | "waiting-for-login" | "completed" | "error" | "stopped";
  logs: LogLine[];
  startedAt: string | null;
  endedAt: string | null;
  csv: string | null;
  error: string | null;
}

interface LogLine {
  timestamp: string;
  stream: "stdout" | "stderr";
  text: string;
}

const MAX_LOG_LINES = 5000;

const runState: RunState = {
  process: null,
  pid: null,
  status: "idle",
  logs: [],
  startedAt: null,
  endedAt: null,
  csv: null,
  error: null,
};

function addLog(stream: "stdout" | "stderr", text: string) {
  const line: LogLine = {
    timestamp: new Date().toISOString(),
    stream,
    text: text.replace(/\r/g, "").trimEnd(),
  };
  if (line.text.length === 0) return;
  runState.logs.push(line);
  if (runState.logs.length > MAX_LOG_LINES) {
    runState.logs = runState.logs.slice(-MAX_LOG_LINES);
  }
  if (
    line.text.includes("Press Enter when you're logged in") ||
    line.text.includes("MANUAL LOGIN REQUIRED")
  ) {
    runState.status = "waiting-for-login";
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const action = body.action as string;

  // --- START ---
  if (action === "start") {
    if (runState.process && runState.status === "running") {
      return NextResponse.json(
        { error: "A run is already in progress. Stop it first." },
        { status: 409 }
      );
    }

    const config = await getConfig();
    const csvRoot = config.csvRoot;
    const pyCmd = body.pythonCmd || config.pythonCmd;
    const scriptPath = path.join(csvRoot, "reddit_browser_subscriber.py");

    const csv = body.csv || "subreddits_sample.csv";
    const csvPath = path.isAbsolute(csv) ? csv : path.join(csvRoot, csv);

    // Verify the script exists
    if (!fsSync.existsSync(scriptPath)) {
      return NextResponse.json(
        {
          error: `Could not find reddit_browser_subscriber.py at: ${scriptPath}. Set the correct CSV Root directory in Settings.`,
          csvRoot,
          scriptPath,
        },
        { status: 404 }
      );
    }

    // Verify the CSV exists
    if (!fsSync.existsSync(csvPath)) {
      return NextResponse.json(
        { error: `Could not find CSV file: ${csvPath}` },
        { status: 404 }
      );
    }

    // Build args
    const args: string[] = [scriptPath, "--csv", csvPath];
    if (body.headless === true) args.push("--headless");
    if (body.verifyOnly) args.push("--verify-only");
    if (body.reprocessFailed) args.push("--reprocess-failed");
    if (body.maxSubscribes) {
      args.push("--max-subscribes", String(body.maxSubscribes));
    }
    // Speed modes — reduce delays for faster processing
    if (body.speedMode === "turbo") {
      args.push("--turbo");
    } else if (body.speedMode === "fast") {
      args.push("--fast");
    }

    // --- Display detection ---
    // On the Pi, Chromium needs a display to run in headed mode. If the
    // Pi booted without a desktop session (no VNC running), we need to
    // provide a virtual display. This only runs on Linux and only when
    // --headless is NOT requested.
    let displayInfo: { display: string; method: string } | null = null;
    if (process.platform !== "win32" && body.headless !== true) {
      displayInfo = ensureDisplay();
      if (displayInfo) {
        addLog("stderr", `[dashboard] Display: ${displayInfo.display} (${displayInfo.method})`);
      } else {
        // No display available — fall back to headless mode automatically
        addLog("stderr", "[dashboard] No display available — falling back to headless mode");
        addLog("stderr", "[dashboard] To see the browser, start your VNC server:");
        addLog("stderr", "[dashboard]   vncserver :1 -geometry 1920x1080");
        if (!args.includes("--headless")) {
          args.push("--headless");
        }
      }
    }

    // Build environment
    const childEnv: Record<string, string> = {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
      // Tell the Python script where the pause-flag file lives so it can
      // check for it between rows and pause when a GitHub update is applying.
      PAUSE_FLAG_FILE: path.join(csvRoot, ".update-pause-flag"),
    };
    // If we detected/started a display, pass it to the child process
    if (displayInfo) {
      childEnv.DISPLAY = displayInfo.display;
    }
    // Use credentials from the request body if provided, otherwise fall back
    // to stored credentials from .config.json (so the user doesn't have to
    // re-enter them every time).
    const redditUsername = body.redditUsername || config.redditUsername || "";
    const redditPassword = body.redditPassword || config.redditPassword || "";
    if (redditUsername) childEnv.REDDIT_USERNAME = redditUsername;
    if (redditPassword) childEnv.REDDIT_PASSWORD = redditPassword;

    addLog("stderr", `[dashboard] Starting: ${pyCmd} ${args.join(" ")}`);
    if (redditUsername) {
      addLog("stderr", `[dashboard] Auto-login enabled for user: ${redditUsername}`);
    }

    runState.logs = [];
    runState.error = null;
    runState.startedAt = new Date().toISOString();
    runState.endedAt = null;
    runState.csv = csv;
    runState.status = "running";

    try {
      const child = spawn(pyCmd, args, {
        cwd: csvRoot,
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv,
      });

      runState.process = child;
      runState.pid = child.pid;

      child.stdout?.on("data", (data: Buffer) => {
        const text = data.toString("utf-8");
        for (const line of text.split("\n")) {
          addLog("stdout", line);
        }
      });

      child.stderr?.on("data", (data: Buffer) => {
        const text = data.toString("utf-8");
        for (const line of text.split("\n")) {
          addLog("stderr", line);
        }
      });

      child.on("exit", (code: number | null, signal: string | null) => {
        runState.endedAt = new Date().toISOString();
        if (signal === "SIGTERM" || signal === "SIGKILL") {
          runState.status = "stopped";
          addLog("stderr", `[dashboard] Process stopped (signal: ${signal})`);
        } else if (code === 0) {
          runState.status = "completed";
          addLog("stderr", `[dashboard] Process completed successfully (exit code 0)`);
        } else {
          runState.status = "error";
          addLog("stderr", `[dashboard] Process exited with error (exit code ${code})`);
        }
        runState.process = null;
        runState.pid = null;
      });

      child.on("error", (err: Error) => {
        runState.status = "error";
        runState.error = err.message;
        runState.endedAt = new Date().toISOString();
        addLog("stderr", `[dashboard] Spawn error: ${err.message}`);
        addLog("stderr", `[dashboard] Tried to run: ${pyCmd} ${args.join(" ")}`);
        addLog("stderr", `[dashboard] If python3 is not found, try setting the Python command in Settings.`);
        runState.process = null;
        runState.pid = null;
      });

      return NextResponse.json({
        ok: true,
        pid: child.pid,
        status: runState.status,
        message: "Script started. A browser window should appear.",
      });
    } catch (err) {
      runState.status = "error";
      runState.error = err instanceof Error ? err.message : String(err);
      runState.endedAt = new Date().toISOString();
      addLog("stderr", `[dashboard] Failed to start: ${runState.error}`);
      return NextResponse.json(
        { error: `Failed to start: ${runState.error}` },
        { status: 500 }
      );
    }
  }

  // --- CONTINUE ---
  if (action === "continue") {
    if (!runState.process || runState.status !== "waiting-for-login") {
      return NextResponse.json(
        { error: "Script is not waiting for login. Current status: " + runState.status },
        { status: 409 }
      );
    }
    try {
      runState.process.stdin?.write("\n");
      runState.status = "running";
      addLog("stderr", "[dashboard] Sent Enter to script — continuing past login prompt");
      return NextResponse.json({ ok: true, message: "Sent Enter to script" });
    } catch (err) {
      return NextResponse.json(
        { error: `Could not write to stdin: ${err}` },
        { status: 500 }
      );
    }
  }

  // --- STOP ---
  if (action === "stop") {
    if (!runState.process) {
      return NextResponse.json({ error: "No process is running" }, { status: 409 });
    }
    try {
      runState.process.kill("SIGTERM");
      setTimeout(() => {
        if (runState.process) {
          try { runState.process.kill("SIGKILL"); } catch {}
        }
      }, 2000);
      addLog("stderr", "[dashboard] Stopping script...");
      return NextResponse.json({ ok: true, message: "Stop signal sent" });
    } catch (err) {
      return NextResponse.json(
        { error: `Could not stop process: ${err}` },
        { status: 500 }
      );
    }
  }

  return NextResponse.json(
    { error: `Unknown action: ${action}. Use 'start', 'stop', or 'continue'.` },
    { status: 400 }
  );
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const sinceIdx = parseInt(searchParams.get("since") || "0", 10);
  const newLogs = runState.logs.slice(sinceIdx);

  const config = await getConfig();

  return NextResponse.json({
    status: runState.status,
    pid: runState.pid,
    startedAt: runState.startedAt,
    endedAt: runState.endedAt,
    csv: runState.csv,
    error: runState.error,
    logs: newLogs,
    totalLogLines: runState.logs.length,
    scriptPath: path.join(config.csvRoot, "reddit_browser_subscriber.py"),
    csvRoot: config.csvRoot,
    pythonCmd: config.pythonCmd,
    platform: process.platform,
  });
}
