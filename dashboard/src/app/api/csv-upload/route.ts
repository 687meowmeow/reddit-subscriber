import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import fsSync from "fs";
import logger from "@/lib/logger";

// ============================================================
// CSV Upload endpoint — accepts a CSV file via multipart/form-data
// and saves it to the configured CSV root directory.
//
// POST /api/csv-upload
//   Form data:
//     file: the CSV file (multipart)
//
// Use case: the user has a .status.csv on their phone/laptop
// (with subscription progress from a previous run) and wants to
// import it to the Pi. The file is saved as-is to csvRoot,
// preserving all columns including `status`, `subscribed_at`,
// `verified`, `error`, etc.
//
// If a file with the same name already exists, it's overwritten.
// ============================================================

async function getCsvRoot(): Promise<string> {
  const configFile = path.join(process.cwd(), ".config.json");
  try {
    const data = await fs.readFile(configFile, "utf-8");
    const config = JSON.parse(data);
    if (config.csvRoot) return config.csvRoot;
  } catch {}
  // Auto-detect: walk up to find reddit_browser_subscriber.py
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

export async function POST(request: NextRequest) {
  const start = Date.now();
  const routeName = "POST /api/csv-upload";
  try {
    const csvRoot = await getCsvRoot();
    logger.info("CSV upload request received", { csvRoot }, routeName);

    // Verify csvRoot exists
    if (!fsSync.existsSync(csvRoot)) {
      logger.error("CSV upload failed — csvRoot does not exist", { csvRoot }, routeName);
      return NextResponse.json(
        { error: `CSV root directory does not exist: ${csvRoot}` },
        { status: 500 }
      );
    }

    // Parse multipart form data
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      logger.warn("CSV upload rejected — no file in form data", {}, routeName);
      return NextResponse.json(
        { error: "No file uploaded. Send a 'file' field in multipart/form-data." },
        { status: 400 }
      );
    }

    // Validate filename — must end in .csv
    const filename = file.name;
    logger.info("CSV upload — file received", {
      filename,
      sizeBytes: file.size,
      type: file.type,
    }, routeName);
    if (!filename.toLowerCase().endsWith(".csv")) {
      logger.warn("CSV upload rejected — not a .csv file", { filename }, routeName);
      return NextResponse.json(
        { error: "File must be a .csv (or .status.csv) file." },
        { status: 400 }
      );
    }

    // Sanitize filename — no path traversal
    const safeName = path.basename(filename);
    if (safeName !== filename) {
      return NextResponse.json(
        { error: "Invalid filename — no path separators allowed." },
        { status: 400 }
      );
    }

    // Read the file content
    const bytes = await file.arrayBuffer();
    const content = Buffer.from(bytes);

    // Basic CSV validation — check it's not empty and has at least one line
    const text = content.toString("utf-8");
    if (text.trim().length === 0) {
      return NextResponse.json(
        { error: "File is empty." },
        { status: 400 }
      );
    }
    const lines = text.split("\n").filter((l) => l.trim());
    if (lines.length < 1) {
      return NextResponse.json(
        { error: "File must contain at least one line (a header or subreddit names)." },
        { status: 400 }
      );
    }

    // Check if a file with the same name already exists
    const destPath = path.join(csvRoot, safeName);
    const fileExists = fsSync.existsSync(destPath);

    // Inspect the uploaded CSV to give the client useful metadata.
    // We do a quick line count + look for a 'status' column header.
    const headerLine = lines[0] || "";
    const headerCells = headerLine.split(",").map(c => c.trim().replace(/^"|"$/g, "").toLowerCase());
    const hasStatusColumn = headerCells.includes("status");
    const isStatusFile = safeName.toLowerCase().endsWith(".status.csv") || hasStatusColumn;
    const hasHeader = headerCells.some(c => ["subreddit", "subreddit_name", "sub", "name", "sr"].includes(c));
    const rowCount = Math.max(0, lines.length - (hasHeader ? 1 : 0));

    // Build a quick statusCounts map (only if there's a status column)
    const statusCounts: Record<string, number> = {};
    if (hasStatusColumn) {
      const statusIdx = headerCells.indexOf("status");
      if (statusIdx >= 0) {
        for (let i = 1; i < lines.length; i++) {
          const cells = lines[i].split(",");
          const s = (cells[statusIdx] || "pending").trim().replace(/^"|"$/g, "").toLowerCase() || "pending";
          statusCounts[s] = (statusCounts[s] || 0) + 1;
        }
      }
    }

    // Save the file
    await fs.writeFile(destPath, content);
    const durationMs = Date.now() - start;
    logger.info("CSV upload — file saved", {
      filename: safeName,
      path: destPath,
      size: content.length,
      rows: rowCount,
      isStatusFile,
      hasStatusColumn,
      statusCounts,
      overwritten: fileExists,
      durationMs,
    }, routeName);

    return NextResponse.json({
      ok: true,
      filename: safeName,
      path: destPath,
      size: content.length,
      rows: rowCount,
      isStatusFile,
      hasHeader,
      hasStatusColumn,
      statusCounts,
      overwritten: fileExists,
      message: fileExists
        ? `Overwrote existing file: ${safeName}`
        : `Uploaded: ${safeName}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("CSV upload failed", { error: message }, routeName, err instanceof Error ? err.stack : undefined);
    return NextResponse.json(
      { error: `Upload failed: ${message}` },
      { status: 500 }
    );
  }
}
