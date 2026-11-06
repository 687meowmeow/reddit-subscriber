import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import fsSync from "fs";
import path from "path";
import logger from "@/lib/logger";

// ============================================================
// /api/logs/download — download the full on-disk log file.
//
// GET /api/logs/download
//   Returns the raw .dashboard.log file as a text/plain attachment.
//   The file is JSONL (one JSON object per line) so it's easy to
//   parse with jq, grep, or any JSONL reader.
//
//   The in-memory ring buffer only holds the last 2000 entries — the
//   disk file is the source of truth for the FULL history.
//
// FIX (previous version wasn't working):
//   1. If the log file doesn't exist yet (no logs written), the old
//      route returned an empty 200 response with Content-Length: 0.
//      Some browsers/blobs handle this poorly. Now we explicitly
//      check for file existence and return a helpful 404 if missing.
//   2. Don't set Content-Length manually — Next.js handles this
//      correctly for variable-length responses. Setting it manually
//      with new TextEncoder().encode(text).length can be wrong for
//      multi-byte UTF-8 characters.
//   3. Use fs.readFile (async) instead of readFileSync — avoids
//      blocking the event loop for large log files.
//   4. Also check the rotated .dashboard.log.1 file and concatenate
//      it if it exists (so the download includes rotated history).
//   5. Log the download request itself so it shows up in the logs.
// ============================================================

export async function GET() {
  const routeName = "GET /api/logs/download";
  const logPath = logger.getLogFilePath();
  const rotatedPath = logPath + ".1";

  logger.info("Log download requested", { logPath, rotatedPath }, routeName);

  // Check if the primary log file exists
  let primaryExists = false;
  try {
    await fs.access(logPath);
    primaryExists = true;
  } catch {
    primaryExists = false;
  }

  // Check if the rotated log file exists
  let rotatedExists = false;
  try {
    await fs.access(rotatedPath);
    rotatedExists = true;
  } catch {
    rotatedExists = false;
  }

  if (!primaryExists && !rotatedExists) {
    logger.warn("Log download failed — no log file exists yet", {
      logPath,
      rotatedPath,
    }, routeName);
    return NextResponse.json(
      {
        error: "No log file exists yet. Logs are created when the first server action occurs. Try refreshing the dashboard or clicking a button first.",
        logPath,
      },
      { status: 404 }
    );
  }

  // Read both files (rotated first, then primary, so chronological order
  // is preserved: oldest entries from .1 come first, newest from primary)
  let combinedText = "";
  let primarySize = 0;
  let rotatedSize = 0;

  if (rotatedExists) {
    try {
      const stat = await fs.stat(rotatedPath);
      rotatedSize = stat.size;
      combinedText = await fs.readFile(rotatedPath, "utf-8");
    } catch (err) {
      logger.warn("Could not read rotated log file", {
        rotatedPath,
        error: err instanceof Error ? err.message : String(err),
      }, routeName);
    }
  }

  if (primaryExists) {
    try {
      const stat = await fs.stat(logPath);
      primarySize = stat.size;
      const primaryText = await fs.readFile(logPath, "utf-8");
      combinedText += primaryText;
    } catch (err) {
      logger.error("Could not read primary log file", {
        logPath,
        error: err instanceof Error ? err.message : String(err),
      }, routeName);
      return NextResponse.json(
        { error: `Could not read log file: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 }
      );
    }
  }

  if (!combinedText) {
    logger.warn("Log file exists but is empty", {
      logPath,
      primarySize,
      rotatedSize,
    }, routeName);
    return NextResponse.json(
      {
        error: "Log file exists but is empty. No log entries have been written yet.",
        logPath,
        primarySize,
        rotatedSize,
      },
      { status: 404 }
    );
  }

  const lineCount = combinedText.split("\n").filter((l) => l.trim()).length;
  const filename = `dashboard-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

  logger.info("Log download complete", {
    primarySize,
    rotatedSize,
    totalSize: combinedText.length,
    lineCount,
    filename,
  }, routeName);

  // Return as a streaming response — don't set Content-Length manually
  // (Next.js handles this correctly, and manual calculation is wrong
  // for multi-byte UTF-8 characters).
  return new NextResponse(combinedText, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET",
      "X-Log-Line-Count": lineCount.toString(),
      "X-Log-Primary-Size": primarySize.toString(),
      "X-Log-Rotated-Size": rotatedSize.toString(),
    },
  });
}
