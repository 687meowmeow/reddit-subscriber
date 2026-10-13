import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import fsSync from "fs";

// ============================================================
// Settings — stored in dashboard/.config.json
// Contains:
//   csvRoot       — where CSV files live
//   pythonCmd     — python3 / python
//   githubRepo    — git remote URL (e.g. https://github.com/USER/REPO.git)
//   githubPat     — Personal Access Token with `repo` scope
//   autoUpdate    — boolean, whether to auto-pull every 60s
// ============================================================

const CONFIG_FILE = path.join(process.cwd(), ".config.json");

interface Config {
  csvRoot: string;
  pythonCmd: string;
  githubRepo?: string;
  githubPat?: string;
  autoUpdate?: boolean;
}

async function readConfig(): Promise<Config> {
  try {
    const data = await fs.readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return { csvRoot: "", pythonCmd: "" };
  }
}

async function writeConfig(config: Config): Promise<void> {
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

// Auto-detect: walk up from cwd to find reddit_browser_subscriber.py
function autoDetectRoot(): string {
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

function autoDetectPython(): string {
  if (process.platform === "win32") return "python";
  return "python3";
}

// Mask the PAT in API responses — never expose the full token to the client
function maskPat(pat?: string): string {
  if (!pat) return "";
  if (pat.length < 10) return "***";
  return pat.slice(0, 4) + "..." + pat.slice(-4);
}

export async function GET() {
  let config = await readConfig();

  if (!config.csvRoot) {
    config.csvRoot = autoDetectRoot();
    await writeConfig(config);
  }
  if (!config.pythonCmd) {
    config.pythonCmd = autoDetectPython();
    await writeConfig(config);
  }

  // Check if the directory exists and is readable
  let dirExists = false;
  let csvCount = 0;
  let csvFiles: string[] = [];
  let scriptExists = false;

  try {
    const entries = await fs.readdir(config.csvRoot);
    dirExists = true;
    csvFiles = entries.filter((f) => f.toLowerCase().endsWith(".csv"));
    csvCount = csvFiles.length;
    scriptExists = fsSync.existsSync(path.join(config.csvRoot, "reddit_browser_subscriber.py"));
  } catch {
    dirExists = false;
  }

  // Check if the project is a git repo
  const isGitRepo = fsSync.existsSync(path.join(config.csvRoot, ".git"));

  return NextResponse.json({
    config: {
      ...config,
      githubPat: maskPat(config.githubPat), // never send full PAT to client
    },
    detected: {
      csvRoot: autoDetectRoot(),
      pythonCmd: autoDetectPython(),
      platform: process.platform,
      cwd: process.cwd(),
    },
    status: {
      dirExists,
      csvCount,
      csvFiles,
      scriptExists,
      isGitRepo,
    },
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const config = await readConfig();

  if (body.csvRoot !== undefined) {
    config.csvRoot = body.csvRoot;
  }
  if (body.pythonCmd !== undefined) {
    config.pythonCmd = body.pythonCmd;
  }
  if (body.githubRepo !== undefined) {
    config.githubRepo = body.githubRepo;
  }
  // For PAT: only update if a non-empty value is sent.
  // Empty string means "clear it"; "***...***" means "leave unchanged".
  if (body.githubPat !== undefined) {
    if (body.githubPat === "") {
      config.githubPat = "";
    } else if (body.githubPat.includes("...")) {
      // masked value returned from GET — don't overwrite the real one
    } else {
      config.githubPat = body.githubPat;
    }
  }
  if (body.autoUpdate !== undefined) {
    config.autoUpdate = Boolean(body.autoUpdate);
  }

  await writeConfig(config);

  // Verify the new settings
  let dirExists = false;
  let csvCount = 0;
  let csvFiles: string[] = [];

  try {
    const entries = await fs.readdir(config.csvRoot);
    dirExists = true;
    csvFiles = entries.filter((f) => f.toLowerCase().endsWith(".csv"));
    csvCount = csvFiles.length;
  } catch {
    dirExists = false;
  }

  return NextResponse.json({
    ok: true,
    config: {
      ...config,
      githubPat: maskPat(config.githubPat),
    },
    status: { dirExists, csvCount, csvFiles },
  });
}
