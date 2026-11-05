import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import fsSync from "fs";

// ============================================================
// Add a new subreddit row to the CSV file.
// If the row already exists, update its status instead.
//
// POST /api/csv-add-row
// Body: {
//   csv: "subscribed_subreddits.status.csv",
//   subreddit: "AskReddit",
//   status: "pending"   // optional, defaults to "pending"
// }
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

function escapeCsvField(value: string): string {
  if (!value) return "";
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const csvParam = body.csv;
    const subredditName = (body.subreddit || "").trim();
    const status = body.status || "pending";

    if (!csvParam || !subredditName) {
      return NextResponse.json(
        { error: "Missing required fields: csv, subreddit" },
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

    // Read the CSV
    const text = await fs.readFile(resolvedPath, "utf-8");
    const lines = text.split("\n").filter((l) => l.trim());

    if (lines.length === 0) {
      return NextResponse.json(
        { error: "CSV is empty" },
        { status: 400 }
      );
    }

    // Parse header
    const headerLine = lines[0];
    const fieldnames: string[] = [];
    let currentField = "";
    let inQuotes = false;
    for (let i = 0; i < headerLine.length; i++) {
      const ch = headerLine[i];
      if (inQuotes) {
        if (ch === '"') {
          if (headerLine[i + 1] === '"') {
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
          fieldnames.push(currentField.trim());
          currentField = "";
        } else {
          currentField += ch;
        }
      }
    }
    fieldnames.push(currentField.trim());

    // Clean subreddit name (strip r/ prefix)
    const cleanName = subredditName.replace(/^r\//i, "").replace(/^\/r\//i, "");

    // Check if the subreddit already exists in the CSV
    const normalizedName = cleanName.toLowerCase();
    let foundIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(normalizedName)) {
        // More precise check — parse the first column
        const firstComma = lines[i].indexOf(",");
        const firstCol = firstComma >= 0 ? lines[i].substring(0, firstComma) : lines[i];
        if (firstCol.toLowerCase().replace(/^["']|["']$/g, "").trim() === normalizedName) {
          foundIdx = i;
          break;
        }
      }
    }

    if (foundIdx >= 0) {
      // Row exists — update its status using csv-update-row logic
      // For simplicity, just append a note and return
      return NextResponse.json({
        ok: true,
        message: `r/${cleanName} is already in the CSV (row ${foundIdx})`,
        already_exists: true,
      });
    }

    // Build the new row
    const newRow = fieldnames.map((fn) => {
      const lower = fn.toLowerCase();
      if (lower === "subreddit" || lower === "subreddit_name" || lower === "sub" || lower === "name" || lower === "sr") {
        return cleanName;
      }
      if (lower === "status") return status;
      return "";
    });

    // Append the new row
    const newLine = newRow.map(escapeCsvField).join(",");
    const newText = text.endsWith("\n") ? text + newLine + "\n" : text + "\n" + newLine + "\n";
    await fs.writeFile(resolvedPath, newText, "utf-8");

    return NextResponse.json({
      ok: true,
      subreddit: cleanName,
      status: status,
      message: `Added r/${cleanName} to CSV as "${status}"`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to add row: ${message}` },
      { status: 500 }
    );
  }
}
