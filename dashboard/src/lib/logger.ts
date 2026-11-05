import { promises as fs } from "fs";
import fsSync from "fs";
import path from "path";

// ============================================================
// Server-side logger — singleton.
//
// Why this exists:
//   The user reported that Find Similar "doesn't work at all — nothing
//   is found". With no logging, we had no way to see WHY. We were
//   flying blind. Reddit killed unauthenticated .json endpoints in
//   May 2026; the find-similar route was calling them with no auth.
//   Without logs, that 403 was invisible.
//
//   This logger captures EVERYTHING the dashboard does:
//     - Every HTTP request (method, path, status, duration) — logged
//       by proxy.ts on every incoming request
//     - Every API route entry/exit (route name, params, response)
//     - Every error with full stack trace
//     - Specific events: CSV reads/writes, run start/stop, GitHub
//       auto-update checks, find-similar fetches, sync-subscriptions
//
//   Logs are stored BOTH in memory (ring buffer, last 2000 entries)
//   and on disk (.dashboard.log, rotated at 5MB). The in-memory copy
//   is what the /api/logs endpoint returns for the live viewer in the
//   UI; the disk copy is what gets downloaded.
//
//   Every entry is JSON (one line per entry) so it's easy to grep,
//   parse, or pipe into jq.
// ============================================================

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "HTTP";

export interface LogEntry {
  timestamp: string;        // ISO 8601
  level: LogLevel;
  message: string;
  route?: string;           // e.g. "GET /api/csv-data"
  requestId?: string;       // for correlating request/response pairs
  durationMs?: number;      // for HTTP requests and route handlers
  data?: any;               // structured payload (params, response, error details)
  stack?: string;           // for ERROR entries — the full stack trace
}

const MAX_RING_BUFFER = 2000;       // keep last 2000 entries in memory
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB before rotation
const MAX_FILE_SIZE_SYNC = 5 * 1024 * 1024;

class Logger {
  private logFile: string;
  private ringBuffer: LogEntry[] = [];
  private writeQueue: Promise<void> = Promise.resolve();
  private seq = 0;

  constructor() {
    // Log file lives in the dashboard's working directory (the
    // dashboard/ folder). It's added to .gitignore so it doesn't
    // pollute the repo.
    this.logFile = path.join(process.cwd(), ".dashboard.log");
  }

  /**
   * Internal: append a single entry to both the ring buffer and the
   * log file. Writes are serialized via a Promise chain to avoid
   * interleaved writes from concurrent requests.
   */
  private append(entry: LogEntry): void {
    // 1. Push to ring buffer (synchronous)
    this.ringBuffer.push(entry);
    if (this.ringBuffer.length > MAX_RING_BUFFER) {
      this.ringBuffer.shift();
    }

    // 2. Append to file (serialized via queue)
    const line = JSON.stringify(entry) + "\n";
    this.writeQueue = this.writeQueue
      .then(() => this.writeLine(line))
      .catch((err) => {
        // Don't let a write failure kill the queue — log to stderr
        // and continue. The ring buffer still has the entry.
        console.error("[logger] file write failed:", err);
      });
  }

  private async writeLine(line: string): Promise<void> {
    try {
      // Check size and rotate if needed
      try {
        const stat = await fs.stat(this.logFile);
        if (stat.size > MAX_FILE_SIZE) {
          // Rotate: .dashboard.log → .dashboard.log.1 (overwrite)
          try { await fs.unlink(this.logFile + ".1"); } catch {}
          try { await fs.rename(this.logFile, this.logFile + ".1"); } catch {}
        }
      } catch {
        // File doesn't exist yet — that's fine
      }
      await fs.appendFile(this.logFile, line, "utf-8");
    } catch (err) {
      console.error("[logger] writeLine error:", err);
    }
  }

  // ---- Public logging methods ----

  info(message: string, data?: any, route?: string): void {
    this.append({
      timestamp: new Date().toISOString(),
      level: "INFO",
      message,
      route,
      data: this.sanitize(data),
    });
  }

  warn(message: string, data?: any, route?: string): void {
    this.append({
      timestamp: new Date().toISOString(),
      level: "WARN",
      message,
      route,
      data: this.sanitize(data),
    });
  }

  error(message: string, data?: any, route?: string, stack?: string): void {
    this.append({
      timestamp: new Date().toISOString(),
      level: "ERROR",
      message,
      route,
      data: this.sanitize(data),
      stack,
    });
  }

  debug(message: string, data?: any, route?: string): void {
    this.append({
      timestamp: new Date().toISOString(),
      level: "DEBUG",
      message,
      route,
      data: this.sanitize(data),
    });
  }

  http(
    method: string,
    url: string,
    status: number,
    durationMs: number,
    requestId?: string,
  ): void {
    this.append({
      timestamp: new Date().toISOString(),
      level: "HTTP",
      message: `${method} ${url} → ${status} (${durationMs}ms)`,
      route: `${method} ${url}`,
      requestId,
      durationMs,
      data: { method, url, status, durationMs },
    });
  }

  /**
   * Generate a short request ID for correlating log entries across
   * the lifetime of a single HTTP request (entry log → exit log).
   */
  nextRequestId(): string {
    this.seq = (this.seq + 1) % 1_000_000;
    return `${Date.now().toString(36)}-${this.seq.toString(36)}`;
  }

  /**
   * Strip sensitive data from log payloads BEFORE they hit disk.
   * We never want to log:
   *   - Passwords (Reddit or GitHub PAT)
   *   - Session cookies
   *   - Authorization headers
   */
  private sanitize(data: any): any {
    if (data == null) return data;
    if (typeof data !== "object") return data;
    // Deep-clone (cheap for small payloads) and walk for sensitive keys
    try {
      const clone = JSON.parse(JSON.stringify(data));
      this.sanitizeInPlace(clone);
      return clone;
    } catch {
      // Not serializable — return as-is but log a warning
      return "[unserializable]";
    }
  }

  private sanitizeInPlace(obj: any): void {
    if (obj == null || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      for (const item of obj) this.sanitizeInPlace(item);
      return;
    }
    for (const key of Object.keys(obj)) {
      const lower = key.toLowerCase();
      if (
        lower.includes("password") ||
        lower.includes("secret") ||
        lower.includes("token") ||
        lower.includes("pat") ||
        lower.includes("authorization") ||
        lower.includes("cookie")
      ) {
        obj[key] = "[REDACTED]";
      } else if (typeof obj[key] === "object") {
        this.sanitizeInPlace(obj[key]);
      }
    }
  }

  // ---- Query methods ----

  /**
   * Return recent log entries, optionally filtered by level and/or
   * a search string. Returns entries newest-first.
   */
  getRecent(opts: {
    count?: number;
    level?: LogLevel | "ALL";
    search?: string;
  } = {}): LogEntry[] {
    const count = opts.count ?? 500;
    let entries = [...this.ringBuffer].reverse();
    if (opts.level && opts.level !== "ALL") {
      entries = entries.filter((e) => e.level === opts.level);
    }
    if (opts.search) {
      const lower = opts.search.toLowerCase();
      entries = entries.filter((e) => {
        if (e.message.toLowerCase().includes(lower)) return true;
        if (e.route && e.route.toLowerCase().includes(lower)) return true;
        if (e.data) {
          try {
            if (JSON.stringify(e.data).toLowerCase().includes(lower)) return true;
          } catch {}
        }
        return false;
      });
    }
    return entries.slice(0, count);
  }

  /**
   * Clear the in-memory ring buffer AND the on-disk log file(s).
   */
  async clear(): Promise<void> {
    this.ringBuffer = [];
    try { await fs.writeFile(this.logFile, "", "utf-8"); } catch {}
    try { await fs.unlink(this.logFile + ".1"); } catch {}
  }

  /**
   * Return the path to the on-disk log file (for the download route).
   */
  getLogFilePath(): string {
    return this.logFile;
  }

  /**
   * Synchronous read of the on-disk log file — used by the download
   * endpoint to return the full file (not just the in-memory buffer).
   */
  readLogFileSync(): string {
    try {
      return fsSync.readFileSync(this.logFile, "utf-8");
    } catch {
      return "";
    }
  }
}

// Singleton — import this everywhere; the same instance is shared
// across all route handlers in the same Node.js process.
const logger = new Logger();

export default logger;
