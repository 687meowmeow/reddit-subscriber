import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import fsSync from "fs";

// ============================================================
// Update a single row's status in the CSV file.
//
// POST /api/csv-update-row
// Body: {
//   csv: "subscribed_subreddits.status.csv",
//   subreddit: "AskReddit",
//   status: "banned",  // or "pending", "subscribed", "failed", etc.
//   error: "optional error message"
// }
//
// Finds the row matching the subreddit name and updates its status.
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

// Simple CSV parser (same as csv-data route)
function parseCsv(text: string): { fieldnames: string[]; rows: string[][] } {
  const lines: string[][] = [];
  let current: string[] = [];
  let currentField = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          currentField += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentField += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        current.push(currentField);
        currentField = "";
      } else if (ch === "\n") {
        current.push(currentField);
        lines.push(current);
        current = [];
        currentField = "";
      } else if (ch === "\r") {
      } else {
        currentField += ch;
      }
    }
  }
  if (currentField.length > 0 || current.length > 0) {
    current.push(currentField);
    lines.push(current);
  }

  if (lines.length === 0) {
    return { fieldnames: ["subreddit"], rows: [] };
  }

  const fieldnames = lines[0].map((c, i) => c.trim() || `col_${i}`);
  return { fieldnames, rows: lines.slice(1).filter((l) => l.some((c) => c.trim() !== "")) };
}

// Escape a CSV field (wrap in quotes if it contains commas, quotes, or newlines)
function escapeCsvField(value: string): string {
  if (!value) return "";
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// Serialize rows back to CSV
function serializeCsv(fieldnames: string[], rows: string[][]): string {
  const lines = [fieldnames.map(escapeCsvField).join(",")];
  for (const row of rows) {
    // Pad row to fieldnames length
    const padded = [...row];
    while (padded.length < fieldnames.length) padded.push("");
    lines.push(padded.slice(0, fieldnames.length).map(escapeCsvField).join(","));
  }
  return lines.join("\n") + "\n";
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const csvParam = body.csv;
    const subredditName = body.subreddit;
    const newStatus = body.status;
    const errorMsg = body.error || "";

    if (!csvParam || !subredditName || !newStatus) {
      return NextResponse.json(
        { error: "Missing required fields: csv, subreddit, status" },
        { status: 400 }
      );
    }

    const csvRoot = await getCsvRoot();
    const resolvedPath = path.isAbsolute(csvParam)
      ? path.resolve(csvParam)
      : path.resolve(csvRoot, csvParam);

    if (!fsSync.existsSync(resolvedPath)) {
      return NextResponse.json(
        { error: `CSV file not found: ${resolvedPath}` },
        { status: 404 }
      );
    }

    // Read and parse the CSV
    const text = await fs.readFile(resolvedPath, "utf-8");
    const { fieldnames, rows } = parseCsv(text);

    // Find the subreddit column
    const DEFAULT_INPUT_COLS = ["subreddit", "subreddit_name", "sub", "name", "sr"];
    let subColIdx = -1;
    for (const col of DEFAULT_INPUT_COLS) {
      const idx = fieldnames.findIndex((f) => f.toLowerCase() === col.toLowerCase());
      if (idx >= 0) {
        subColIdx = idx;
        break;
      }
    }
    if (subColIdx < 0) {
      subColIdx = 0; // fallback to first column
    }

    // Find the status column
    let statusColIdx = fieldnames.findIndex((f) => f.toLowerCase() === "status");
    if (statusColIdx < 0) {
      // No status column — can't update
      return NextResponse.json(
        { error: "CSV doesn't have a 'status' column" },
        { status: 400 }
      );
    }

    // Find the error column
    let errorColIdx = fieldnames.findIndex((f) => f.toLowerCase() === "error");

    // Find the row matching the subreddit name (case-insensitive)
    const normalizedName = subredditName.toLowerCase().replace(/^r\//, "").replace(/^u_/, "").replace(/^u\//, "");
    let foundIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      const rowName = (rows[i][subColIdx] || "").toLowerCase()
        .replace(/^r\//, "").replace(/^u_/, "").replace(/^u\//, "");
      if (rowName === normalizedName) {
        foundIdx = i;
        break;
      }
    }

    if (foundIdx < 0) {
      return NextResponse.json(
        { error: `Subreddit '${subredditName}' not found in CSV` },
        { status: 404 }
      );
    }

    // Update the status
    const oldStatus = rows[foundIdx][statusColIdx] || "pending";
    rows[foundIdx][statusColIdx] = newStatus;

    // Update the error column if provided and exists
    if (errorColIdx >= 0 && errorMsg !== undefined) {
      rows[foundIdx][errorColIdx] = errorMsg;
    }

    // Clear the subscribed_at timestamp if setting to pending
    if (newStatus.toLowerCase() === "pending") {
      const subAtIdx = fieldnames.findIndex((f) => f.toLowerCase() === "subscribed_at");
      if (subAtIdx >= 0) {
        rows[foundIdx][subAtIdx] = "";
      }
    }

    // Write the CSV back
    const csvOutput = serializeCsv(fieldnames, rows);
    await fs.writeFile(resolvedPath, csvOutput, "utf-8");

    return NextResponse.json({
      ok: true,
      subreddit: subredditName,
      oldStatus: oldStatus,
      newStatus: newStatus,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to update row: ${message}` },
      { status: 500 }
    );
  }
}
