import { NextRequest, NextResponse } from "next/server";
import * as fsSync from "fs";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";

// ============================================================
// Debug endpoint — useful for diagnosing remote-access issues.
// Shows: request headers, server info, config, file resolution.
// ============================================================

export async function GET(request: NextRequest) {
  const debug: Record<string, any> = {
    timestamp: new Date().toISOString(),
  };

  // --- Request info (useful for remote-access debugging) ---
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = key.toLowerCase().includes("auth") ? "[redacted]" : value;
  });

  const host = request.headers.get("host") || "(none)";
  const origin = request.headers.get("origin") || "(none)";
  const referer = request.headers.get("referer") || "(none)";
  const isLocalhost =
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1") ||
    host.startsWith("[::1]");

  debug.request = {
    url: request.url,
    method: request.method,
    host,
    origin,
    referer,
    userAgent: request.headers.get("user-agent") || "(none)",
    isLocalhost,
    note: isLocalhost
      ? "Request came from localhost — this works."
      : "Request came from a remote device. If buttons aren't working, check allowedDevOrigins in next.config.ts.",
  };
  debug.requestHeaders = headers;

  // --- Server info ---
  const networkInterfaces = os.networkInterfaces();
  const ips: string[] = [];
  for (const [, ifaces] of Object.entries(networkInterfaces)) {
    if (!ifaces) continue;
    for (const iface of ifaces) {
      if (iface.family === "IPv4" && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }

  debug.server = {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    hostname: os.hostname(),
    cwd: process.cwd(),
    networkIPs: ips,
    port: process.env.PORT || "(default)",
    pythonCheck: checkPython(),
  };

  // --- Config file ---
  const configFile = path.join(process.cwd(), ".config.json");
  let configExists = false;
  let config: { csvRoot?: string; pythonCmd?: string } = {};
  try {
    const data = await fs.readFile(configFile, "utf-8");
    config = JSON.parse(data);
    configExists = true;
  } catch {
    configExists = false;
  }

  debug.config = {
    file: configFile,
    exists: configExists,
    contents: config,
  };

  // --- CSV root resolution ---
  const resolution = resolveCsvRoot(config.csvRoot);
  debug.csvRootResolution = resolution;

  // --- Verify the script exists ---
  const scriptPath = path.join(resolution.root, "reddit_browser_subscriber.py");
  debug.script = {
    path: scriptPath,
    exists: fsSync.existsSync(scriptPath),
  };

  // --- List CSVs in the resolved root ---
  try {
    const entries = await fs.readdir(resolution.root, { withFileTypes: true });
    const csvFiles = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".csv"))
      .map((e) => ({
        name: e.name,
        size: fsSync.statSync(path.join(resolution.root, e.name)).size,
      }));
    debug.csvFiles = {
      root: resolution.root,
      count: csvFiles.length,
      files: csvFiles,
    };
  } catch (err) {
    debug.csvFiles = {
      root: resolution.root,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // --- Final summary ---
  const issues: string[] = [];
  if (!config.csvRoot) issues.push("CSV root not configured — using auto-detect.");
  if (!debug.script.exists) issues.push(`reddit_browser_subscriber.py NOT FOUND at ${scriptPath}`);
  if (!config.pythonCmd) issues.push("Python command not configured — will auto-detect.");
  if (debug.csvFiles?.error) issues.push(`Cannot read CSV directory: ${debug.csvFiles.error}`);
  if (debug.csvFiles?.count === 0) issues.push("CSV directory exists but contains no .csv files.");
  if (!isLocalhost && !ips.length)
    issues.push("Server has no detectable external IP — check your network.");
  debug.issues = issues;

  return NextResponse.json(debug);
}

function checkPython(): { cmd: string; available: boolean; version: string | null } {
  const cmds = ["python3", "python"];
  for (const cmd of cmds) {
    try {
      const version = execSync(`${cmd} --version`, { encoding: "utf-8" }).trim();
      return { cmd, available: true, version };
    } catch {}
  }
  return { cmd: "(none)", available: false, version: null };
}

function resolveCsvRoot(configuredRoot?: string): {
  root: string;
  source: "config" | "auto-detect" | "fallback";
  steps: string[];
} {
  const steps: string[] = [];

  // 1. Use configured root if it exists
  if (configuredRoot) {
    steps.push(`Configured root: ${configuredRoot}`);
    if (fsSync.existsSync(configuredRoot)) {
      steps.push("  -> exists, using it.");
      return { root: configuredRoot, source: "config", steps };
    }
    steps.push("  -> does NOT exist, falling back to auto-detect.");
  } else {
    steps.push("No configured root, auto-detecting...");
  }

  // 2. Walk up to find reddit_browser_subscriber.py
  let current = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(current, "reddit_browser_subscriber.py");
    const exists = fsSync.existsSync(candidate);
    steps.push(`Step ${i}: ${candidate} — ${exists ? "FOUND" : "not found"}`);
    if (exists) {
      return { root: current, source: "auto-detect", steps };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // 3. Fallback to parent of cwd
  const fallback = path.resolve(process.cwd(), "..");
  steps.push(`Fallback: parent of cwd = ${fallback}`);
  return { root: fallback, source: "fallback", steps };
}
