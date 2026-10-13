import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import fsSync from "fs";

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
  try {
    const csvRoot = await getCsvRoot();

    // Verify csvRoot exists
    if (!fsSync.existsSync(csvRoot)) {
      return NextResponse.json(
        { error: `CSV root directory does not exist: ${csvRoot}` },
        { status: 500 }
      );
    }

    // Parse multipart form data
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "No file uploaded. Send a 'file' field in multipart/form-data." },
        { status: 400 }
      );
    }

    // Validate filename — must end in .csv
    const filename = file.name;
    if (!filename.toLowerCase().endsWith(".csv")) {
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

    // Save the file
    await fs.writeFile(destPath, content);

    // Detect what kind of file this is
    const isStatusFile = safeName.toLowerCase().endsWith(".status.csv");
    const firstLine = lines[0].toLowerCase();
    const hasHeader = ["subreddit", "subreddit_name", "sub", "name", "sr"].some((col) =>
      firstLine.includes(col)
    );
    const hasStatusColumn = firstLine.includes("status");

    // Count rows
    const rowCount = hasHeader ? lines.length - 1 : lines.length;

    // Count statuses (if it's a status file)
    const statusCounts: Record<string, number> = {};
    if (hasStatusColumn) {
      const headerCols = lines[0].split(",").map((c) => c.trim().toLowerCase());
      const statusIdx = headerCols.indexOf("status");
      if (statusIdx >= 0) {
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(",");
          const status = (cols[statusIdx] || "pending").trim() || "pending";
          statusCounts[status] = (statusCounts[status] || 0) + 1;
        }
      }
    }

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
    return NextResponse.json(
      { error: `Upload failed: ${message}` },
      { status: 500 }
    );
  }
}
