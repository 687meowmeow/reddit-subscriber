import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import fsSync from "fs";

// ============================================================
// Read config from .config.json
// ============================================================
async function getCsvRoot(): Promise<string> {
  const configFile = path.join(process.cwd(), ".config.json");
  try {
    const data = await fs.readFile(configFile, "utf-8");
    const config = JSON.parse(data);
    if (config.csvRoot) return config.csvRoot;
  } catch {}
  // Auto-detect
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

interface SubredditRow {
  [key: string]: string;
}

interface CsvData {
  rows: SubredditRow[];
  fieldnames: string[];
  totalRows: number;
  counts: Record<string, number>;
  csvPath: string;
  csvName: string;
  lastModified: string | null;
  subCol: string | null;
  error?: string;
}

function parseCsv(text: string): { fieldnames: string[]; rows: SubredditRow[] } {
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

  const DEFAULT_INPUT_COLS = ["subreddit", "subreddit_name", "sub", "name", "sr"];
  const firstRow = lines[0];
  const firstRowLower = firstRow.map((c) => c.trim().toLowerCase());
  let hasHeader = firstRowLower.some((c) => DEFAULT_INPUT_COLS.includes(c));
  if (!hasHeader && firstRow.length > 1) {
    hasHeader = firstRowLower.some((c) => c && !/^[a-z0-9_]+$/i.test(c));
  }

  let fieldnames: string[];
  let dataLines: string[][];

  if (hasHeader) {
    fieldnames = firstRow.map((c, i) => c.trim() || `col_${i}`);
    dataLines = lines.slice(1);
  } else {
    const ncols = Math.max(...lines.map((l) => l.length));
    fieldnames = ncols <= 1 ? ["subreddit"] : Array.from({ length: ncols }, (_, i) => `col_${i}`);
    dataLines = lines;
  }

  const rows: SubredditRow[] = dataLines
    .filter((line) => line.some((cell) => cell.trim() !== ""))
    .map((line) => {
      const row: SubredditRow = {};
      fieldnames.forEach((fn, i) => {
        row[fn] = line[i] ?? "";
      });
      return row;
    });

  return { fieldnames, rows };
}

function detectSubCol(fieldnames: string[]): string | null {
  const DEFAULT_INPUT_COLS = ["subreddit", "subreddit_name", "sub", "name", "sr"];
  for (const c of DEFAULT_INPUT_COLS) {
    if (fieldnames.includes(c)) return c;
  }
  return fieldnames[0] ?? null;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const csvParam = searchParams.get("csv") || "subreddits_sample.csv";
  const ALLOWED_ROOT = await getCsvRoot();

  let resolvedPath: string;
  if (path.isAbsolute(csvParam)) {
    resolvedPath = path.resolve(csvParam);
  } else {
    resolvedPath = path.resolve(ALLOWED_ROOT, csvParam);
  }

  const normalizedRoot = path.normalize(ALLOWED_ROOT);
  const normalizedPath = path.normalize(resolvedPath);
  if (
    !normalizedPath.startsWith(normalizedRoot + path.sep) &&
    normalizedPath !== normalizedRoot
  ) {
    return NextResponse.json(
      {
        error: "CSV path must be inside the project root directory.",
        allowedRoot: ALLOWED_ROOT,
        attemptedPath: resolvedPath,
      },
      { status: 403 }
    );
  }

  try {
    const text = await fs.readFile(resolvedPath, "utf-8");
    const { fieldnames, rows } = parseCsv(text);
    const subCol = detectSubCol(fieldnames);

    const counts: Record<string, number> = {};
    for (const row of rows) {
      const status = (row.status || "pending").trim() || "pending";
      counts[status] = (counts[status] || 0) + 1;
    }

    let lastModified: string | null = null;
    try {
      const stat = await fs.stat(resolvedPath);
      lastModified = stat.mtime.toISOString();
    } catch {}

    const csvData: CsvData = {
      rows,
      fieldnames,
      totalRows: rows.length,
      counts,
      csvPath: resolvedPath,
      csvName: path.basename(resolvedPath),
      lastModified,
      subCol,
    };

    return NextResponse.json(csvData);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Could not read CSV: ${message}`, csvPath: resolvedPath, allowedRoot: ALLOWED_ROOT },
      { status: 404 }
    );
  }
}
