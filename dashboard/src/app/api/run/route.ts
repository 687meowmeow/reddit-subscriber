import { NextRequest, NextResponse } from "next/server";
import { spawn, ChildProcess } from "child_process";
import path from "path";
import { promises as fs } from "fs";
import fsSync from "fs";

// ============================================================
// Read config from .config.json
// ============================================================
async function getConfig(): Promise<{ csvRoot: string; pythonCmd: string }> {
  const configFile = path.join(process.cwd(), ".config.json");
  try {
    const data = await fs.readFile(configFile, "utf-8");
    return JSON.parse(data);
  } catch {
    // Auto-detect
    let current = process.cwd();
    for (let i = 0; i < 10; i++) {
      if (fsSync.existsSync(path.join(current, "reddit_browser_subscriber.py"))) {
        return { csvRoot: current, pythonCmd: process.platform === "win32" ? "python" : "python3" };
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return { csvRoot: path.resolve(process.cwd(), ".."), pythonCmd: process.platform === "win32" ? "python" : "python3" };
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

    // Build environment
    const childEnv: Record<string, string> = {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
    };
    if (body.redditUsername) childEnv.REDDIT_USERNAME = body.redditUsername;
    if (body.redditPassword) childEnv.REDDIT_PASSWORD = body.redditPassword;

    addLog("stderr", `[dashboard] Starting: ${pyCmd} ${args.join(" ")}`);
    if (body.redditUsername) {
      addLog("stderr", `[dashboard] Auto-login enabled for user: ${body.redditUsername}`);
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
