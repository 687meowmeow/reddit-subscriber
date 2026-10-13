import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import fsSync from "fs";

// ============================================================
// Read config from .config.json (same as /api/settings)
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

interface CsvFile {
  name: string;
  path: string;
  size: number;
  lastModified: string;
  isStatusFile: boolean;
  inputFileName: string | null;
}

export async function GET() {
  const ALLOWED_ROOT = await getCsvRoot();

  const debugInfo: Record<string, any> = {
    cwd: process.cwd(),
    allowedRoot: ALLOWED_ROOT,
    configExists: fsSync.existsSync(path.join(process.cwd(), ".config.json")),
  };

  try {
    const entries = await fs.readdir(ALLOWED_ROOT, { withFileTypes: true });
    debugInfo.entries = entries.map((e) => e.name);

    const allCsvFiles: CsvFile[] = [];

    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".csv")) {
        const fullPath = path.join(ALLOWED_ROOT, entry.name);
        try {
          const stat = await fs.stat(fullPath);
          const isStatusFile = entry.name.toLowerCase().endsWith(".status.csv");
          let inputFileName: string | null = null;
          if (isStatusFile) {
            const baseName = entry.name.slice(0, -".status.csv".length);
            inputFileName = baseName + ".csv";
          }
          allCsvFiles.push({
            name: entry.name,
            path: fullPath,
            size: stat.size,
            lastModified: stat.mtime.toISOString(),
            isStatusFile,
            inputFileName,
          });
        } catch {}
      }
    }

    debugInfo.csvCount = allCsvFiles.length;

    // Filter: prefer status files over input files
    const statusFileInputNames = new Set(
      allCsvFiles.filter((f) => f.isStatusFile).map((f) => f.inputFileName)
    );
    const visibleFiles = allCsvFiles.filter((f) => {
      if (!f.isStatusFile && statusFileInputNames.has(f.name)) return false;
      return true;
    });

    visibleFiles.sort((a, b) => {
      if (a.isStatusFile !== b.isStatusFile) return a.isStatusFile ? -1 : 1;
      return b.lastModified.localeCompare(a.lastModified);
    });

    return NextResponse.json({
      files: visibleFiles,
      root: ALLOWED_ROOT,
      debug: debugInfo,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Could not list CSV files: ${message}`, debug: debugInfo },
      { status: 500 }
    );
  }
}
