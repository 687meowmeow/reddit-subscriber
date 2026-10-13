import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import fsSync from "fs";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// ============================================================
// Auto-update endpoint — called by the dashboard every 60s.
//
// 1. Reads config (githubRepo, githubPat, autoUpdate)
// 2. If autoUpdate is disabled, just returns current commit info
// 3. Runs `git fetch origin` (using PAT for auth if needed)
// 4. Compares local HEAD with remote HEAD
// 5. If different, runs `git reset --hard origin/<branch>` and returns what changed
// 6. If package.json or requirements.txt changed, runs install
// 7. Returns: { hasUpdates, oldCommit, newCommit, changedFiles }
//
// The Next.js dev server will auto-reload when files change (HMR),
// so frontend updates apply immediately. For the Python subscriber
// script, the running process (if any) keeps the old code in memory
// — the new code applies on the next Start.
// ============================================================

interface Config {
  csvRoot: string;
  pythonCmd: string;
  githubRepo?: string;
  githubPat?: string;
  autoUpdate?: boolean;
}

async function readConfig(): Promise<Config> {
  const configFile = path.join(process.cwd(), ".config.json");
  try {
    const data = await fs.readFile(configFile, "utf-8");
    return JSON.parse(data);
  } catch {
    return { csvRoot: "", pythonCmd: "" };
  }
}

// Build the authed remote URL: https://PAT@github.com/USER/REPO.git
function authedRemoteUrl(repoUrl: string, pat?: string): string {
  if (!pat) return repoUrl;
  if (!repoUrl.startsWith("https://") && !repoUrl.startsWith("http://")) {
    return repoUrl;
  }
  if (repoUrl.includes("@")) return repoUrl;
  return repoUrl.replace(/^(https?:\/\/)/, `$1${pat}@`);
}

// Safely run a git command in the project root
async function git(args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
  const cmd = `git ${args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ")}`;
  try {
    const { stdout } = await execAsync(cmd, {
      cwd,
      env: { ...process.env, ...env },
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.toString().trim();
  } catch (err: any) {
    if (args[0] === "diff" && err.code === 1) {
      return err.stdout?.toString().trim() || "";
    }
    throw new Error(`git ${args.join(" ")} failed: ${err.message}`);
  }
}

function isGitRepo(cwd: string): boolean {
  return fsSync.existsSync(path.join(cwd, ".git"));
}

async function getHeadCommit(cwd: string): Promise<string | null> {
  try {
    return await git(["rev-parse", "HEAD"], cwd);
  } catch {
    return null;
  }
}

async function getRemoteHead(cwd: string, branch: string): Promise<string | null> {
  try {
    await git(["fetch", "origin", branch], cwd, {
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "true",
    });
    return await git(["rev-parse", `origin/${branch}`], cwd);
  } catch {
    return null;
  }
}

async function getChangedFiles(cwd: string, oldCommit: string, newCommit: string): Promise<string[]> {
  try {
    const output = await git(["diff", "--name-only", `${oldCommit}..${newCommit}`], cwd);
    if (!output) return [];
    return output.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function getCommitLog(cwd: string, oldCommit: string, newCommit: string): Promise<string[]> {
  try {
    const output = await git(["log", "--oneline", "--no-decorate", `${oldCommit}..${newCommit}`], cwd);
    if (!output) return [];
    return output.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function getBranch(cwd: string): Promise<string> {
  try {
    return await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  } catch {
    return "main";
  }
}

async function installNodeDeps(dashboardDir: string): Promise<boolean> {
  if (!fsSync.existsSync(path.join(dashboardDir, "package.json"))) return false;
  try {
    await execAsync("npm install --silent", {
      cwd: dashboardDir,
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 10,
    });
    return true;
  } catch (err) {
    console.error("[auto-update] npm install failed:", err);
    return false;
  }
}

async function installPythonDeps(cwd: string, pythonCmd: string): Promise<boolean> {
  if (!fsSync.existsSync(path.join(cwd, "requirements.txt"))) return false;
  try {
    await execAsync(`${pythonCmd} -m pip install -r requirements.txt --quiet`, {
      cwd,
      timeout: 120000,
      maxBuffer: 1024 * 1024 * 10,
    });
    return true;
  } catch (err) {
    console.error("[auto-update] pip install failed:", err);
    return false;
  }
}

export async function GET() {
  const config = await readConfig();
  const cwd = config.csvRoot || path.resolve(process.cwd(), "..");

  if (!isGitRepo(cwd)) {
    return NextResponse.json({
      enabled: false,
      isGitRepo: false,
      error: "Project directory is not a git repository. Run ./setup-git.sh first.",
      currentCommit: null,
      branch: null,
      lastChecked: new Date().toISOString(),
    });
  }

  const branch = await getBranch(cwd);
  const currentCommit = await getHeadCommit(cwd);
  const enabled = Boolean(config.autoUpdate && config.githubRepo);

  if (!enabled) {
    return NextResponse.json({
      enabled: false,
      isGitRepo: true,
      currentCommit,
      branch,
      lastChecked: new Date().toISOString(),
    });
  }

  try {
    // The repo is public, so we don't need PAT for fetch/pull.
    // Set the remote to the plain URL (without PAT) to avoid auth issues.
    const plainUrl = config.githubRepo!;

    try {
      await git(["remote", "set-url", "origin", plainUrl], cwd);
    } catch {}

    const remoteHead = await getRemoteHead(cwd, branch);

    if (!remoteHead) {
      return NextResponse.json({
        enabled: true,
        isGitRepo: true,
        currentCommit,
        branch,
        error: "Could not fetch from remote. Check your GitHub repo URL.",
        lastChecked: new Date().toISOString(),
      });
    }

    if (currentCommit === remoteHead) {
      return NextResponse.json({
        enabled: true,
        isGitRepo: true,
        currentCommit,
        remoteCommit: remoteHead,
        branch,
        upToDate: true,
        lastChecked: new Date().toISOString(),
      });
    }

    const oldCommit = currentCommit;
    const newCommit = remoteHead;
    const changedFiles = await getChangedFiles(cwd, oldCommit || "HEAD", newCommit);
    const commitLog = await getCommitLog(cwd, oldCommit || "HEAD", newCommit);

    // --- PAUSE FLAG ---
    // Create a pause-flag file so the running Python subscriber knows to
    // stop processing new rows while we apply the update. The subscriber
    // checks for this file at the start of each row iteration.
    const pauseFlagPath = path.join(cwd, ".update-pause-flag");
    try {
      await fs.writeFile(pauseFlagPath, "paused", "utf-8");
      // Give the subscriber a moment to notice the flag and finish any
      // in-progress page load before we start modifying files.
      await new Promise((resolve) => setTimeout(resolve, 3000));
    } catch {}

    // Use `git reset --hard origin/<branch>` instead of `git pull`.
    // This discards any local changes to TRACKED files (like start.sh)
    // that the user may have edited, but PRESERVES all UNTRACKED files
    // (like *.status.csv, .config.json, browser profile) because they're
    // in .gitignore and git doesn't touch them.
    //
    // We already fetched above (in getRemoteHead), so origin/<branch>
    // is up to date. Just reset to it.
    try {
      await git(["reset", "--hard", `origin/${branch}`], cwd, {
        GIT_TERMINAL_PROMPT: "0",
      });
    } catch (err: any) {
      // Remove the pause flag even on error so the subscriber can continue
      try { await fs.unlink(pauseFlagPath); } catch {}
      return NextResponse.json({
        enabled: true,
        isGitRepo: true,
        currentCommit,
        branch,
        error: `git reset --hard failed: ${err.message}`,
        lastChecked: new Date().toISOString(),
      });
    }

    let nodeDepsInstalled = false;
    let pythonDepsInstalled = false;
    if (changedFiles.some((f) => f.startsWith("dashboard/") && f.endsWith("package.json"))) {
      nodeDepsInstalled = await installNodeDeps(path.join(cwd, "dashboard"));
    }
    if (changedFiles.includes("requirements.txt")) {
      pythonDepsInstalled = await installPythonDeps(cwd, config.pythonCmd);
    }

    // --- REMOVE PAUSE FLAG ---
    // The update is done — let the subscriber resume processing.
    try { await fs.unlink(pauseFlagPath); } catch {}

    const pythonScriptChanged = changedFiles.includes("reddit_browser_subscriber.py");
    const nextConfigChanged = changedFiles.some(
      (f) => f === "dashboard/next.config.ts" || f === "dashboard/package.json"
    );
    const dashboardCodeChanged = changedFiles.some(
      (f) => f.startsWith("dashboard/src/") || f.startsWith("dashboard/public/")
    );

    return NextResponse.json({
      enabled: true,
      isGitRepo: true,
      upToDate: false,
      updated: true,
      oldCommit,
      newCommit,
      branch,
      changedFiles,
      commitLog,
      nodeDepsInstalled,
      pythonDepsInstalled,
      pythonScriptChanged,
      nextConfigChanged,
      dashboardCodeChanged,
      lastChecked: new Date().toISOString(),
      message: `Pulled ${commitLog.length} new commit${commitLog.length === 1 ? "" : "s"}.`,
    });
  } catch (err: any) {
    return NextResponse.json({
      enabled: true,
      isGitRepo: true,
      currentCommit,
      branch,
      error: err.message || String(err),
      lastChecked: new Date().toISOString(),
    });
  }
}

export async function POST() {
  return GET();
}
