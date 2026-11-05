import { NextResponse } from "next/server";
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
// ============================================================

export async function GET() {
  const text = logger.readLogFileSync();
  const filename = `dashboard-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;

  return new NextResponse(text, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": new TextEncoder().encode(text).length.toString(),
      // CORS — already added by proxy.ts, but explicit doesn't hurt
      "Access-Control-Allow-Origin": "*",
    },
  });
}
