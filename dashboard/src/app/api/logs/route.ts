import { NextRequest, NextResponse } from "next/server";
import logger, { LogLevel } from "@/lib/logger";

// ============================================================
// /api/logs — read and clear server logs.
//
// GET  /api/logs?count=500&level=ERROR&search=find-similar
//   Returns recent log entries, newest-first.
//   - count:  number of entries (default 500, max 2000)
//   - level:  one of DEBUG|INFO|WARN|ERROR|HTTP|ALL (default ALL)
//   - search: substring filter on message/route/data (case-insensitive)
//
// DELETE /api/logs
//   Clears both the in-memory ring buffer and the on-disk log file.
// ============================================================

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const countStr = searchParams.get("count") || "500";
  const level = (searchParams.get("level") || "ALL") as LogLevel | "ALL";
  const search = searchParams.get("search") || undefined;

  let count = parseInt(countStr, 10);
  if (isNaN(count) || count < 1) count = 500;
  if (count > 2000) count = 2000;

  const entries = logger.getRecent({ count, level, search });

  return NextResponse.json({
    ok: true,
    count: entries.length,
    entries,
    fetchedAt: new Date().toISOString(),
  });
}

export async function DELETE() {
  await logger.clear();
  logger.info("Logs cleared by user", undefined, "DELETE /api/logs");
  return NextResponse.json({ ok: true, message: "Logs cleared" });
}
