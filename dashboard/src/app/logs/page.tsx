'use client'

import { useState, useEffect, useCallback, useRef, useMemo, Suspense } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft, Download, Trash2, Play, Pause, Search,
  Loader2, Terminal, Filter, RefreshCw, CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

// ============================================================
// /logs — server-side log viewer.
//
// Why a separate page:
//   The user explicitly asked to "replace the useless debug menu
//   with actual logging for every single thing that this website
//   does" and to make logs downloadable. This page is the UI for
//   the server-side logger (src/lib/logger.ts) that captures:
//     - Every HTTP request (method, path, status, duration)
//     - Every API route entry/exit
//     - Every error with stack trace
//     - Specific events: CSV reads/writes, run start/stop, GitHub
//       auto-update checks, find-similar fetches, sync-subscriptions
//
// Features:
//   - Live tail (polls /api/logs every 2s when paused off)
//   - Filter by level (chips: ALL / DEBUG / INFO / WARN / ERROR / HTTP)
//   - Filter by route (dropdown — populated from observed routes)
//   - Search box (case-insensitive substring on message/route/data)
//   - Download button (downloads the FULL log file, not just the
//     in-memory buffer)
//   - Clear button (with confirmation — clears both in-memory + disk)
//   - Auto-scroll toggle (jump to newest entries automatically)
//   - Copy button (copies all visible entries to clipboard)
//   - Color-coded by level
//   - Tabular-nums font for timestamps + durations
// ============================================================

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "HTTP";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  route?: string;
  requestId?: string;
  durationMs?: number;
  data?: any;
  stack?: string;
}

const LEVEL_COLORS: Record<LogLevel, string> = {
  DEBUG: "text-slate-400",
  INFO: "text-sky-400",
  WARN: "text-amber-400",
  ERROR: "text-red-400",
  HTTP: "text-emerald-400",
};

const LEVEL_BG: Record<LogLevel, string> = {
  DEBUG: "bg-slate-700/40 border-slate-600",
  INFO: "bg-sky-950/40 border-sky-800",
  WARN: "bg-amber-950/40 border-amber-800",
  ERROR: "bg-red-950/40 border-red-800",
  HTTP: "bg-emerald-950/40 border-emerald-800",
};

const LEVELS: (LogLevel | "ALL")[] = ["ALL", "DEBUG", "INFO", "WARN", "ERROR", "HTTP"];

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }) + "." + String(d.getMilliseconds()).padStart(3, "0");
  } catch {
    return iso;
  }
}

function LogsContent() {
  const router = useRouter();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [levelFilter, setLevelFilter] = useState<LogLevel | "ALL">("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [debouncedSearch, setDebouncedSearch] = useState<string>("");
  const [routeFilter, setRouteFilter] = useState<string>("ALL");
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [confirmingClear, setConfirmingClear] = useState<boolean>(false);
  const [clearing, setClearing] = useState<boolean>(false);
  const [downloading, setDownloading] = useState<boolean>(false);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const [totalEntries, setTotalEntries] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef<boolean>(true);

  // Debounce search input
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(value);
    }, 300);
  }, []);

  // Fetch logs
  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set("count", "500");
      if (levelFilter !== "ALL") params.set("level", levelFilter);
      if (debouncedSearch) params.set("search", debouncedSearch);

      const res = await fetch(`/api/logs?${params.toString()}`);
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      setEntries(data.entries || []);
      setTotalEntries(data.count || 0);
      setLastFetch(new Date());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [levelFilter, debouncedSearch]);

  // Initial load — fetch recent history
  useEffect(() => {
    setLoading(true);
    fetchLogs().finally(() => setLoading(false));
  }, [fetchLogs]);

  // ============================================================
  // SSE (Server-Sent Events) — real-time log streaming.
  //
  // Instead of polling /api/logs every 2 seconds, we connect to
  // /api/logs/stream which pushes new entries as they happen.
  // This is:
  //   - Instant (no 2s delay)
  //   - Lower bandwidth (no repeated full history fetches)
  //   - Lower server load (one connection, not a poll every 2s)
  //
  // When autoRefresh is ON, we connect to SSE. When OFF, we disconnect.
  // ============================================================
  const sseRef = useRef<EventSource | null>(null);
  const [sseConnected, setSseConnected] = useState<boolean>(false);

  useEffect(() => {
    if (!autoRefresh) {
      // Disconnect SSE if it was open
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
        setSseConnected(false);
      }
      return;
    }

    // Connect to SSE
    const eventSource = new EventSource("/api/logs/stream");
    sseRef.current = eventSource;

    eventSource.onopen = () => {
      setSseConnected(true);
    };

    eventSource.onerror = () => {
      setSseConnected(false);
      // EventSource will auto-reconnect — we just update the UI state
    };

    eventSource.onmessage = (event) => {
      try {
        const entry: LogEntry = JSON.parse(event.data);
        // Append the new entry to the list (cap at 500 visible entries)
        setEntries((prev) => {
          const combined = [...prev, entry];
          if (combined.length > 500) {
            return combined.slice(-500);
          }
          return combined;
        });
        setTotalEntries((prev) => prev + 1);
        setLastFetch(new Date());
      } catch {
        // Ignore parse errors (heartbeats, etc.)
      }
    };

    return () => {
      eventSource.close();
      sseRef.current = null;
      setSseConnected(false);
    };
  }, [autoRefresh]); // NOTE: don't include levelFilter/debouncedSearch here —
                     // SSE pushes ALL entries; filtering is done client-side.
                     // We only re-connect when autoRefresh is toggled.

  // When filters change, do a fresh fetch to get filtered history
  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // Auto-scroll to bottom when new entries arrive (only if user was at bottom)
  useEffect(() => {
    if (autoScroll && wasAtBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  // Track scroll position to decide if we should auto-scroll
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 50;
    wasAtBottomRef.current = atBottom;
  }, []);

  // Apply route filter client-side (since the API doesn't filter by route)
  const visibleEntries = routeFilter === "ALL"
    ? entries
    : entries.filter(e => (e.route || "").includes(routeFilter));

  // Collect unique routes for the filter dropdown
  const allRoutes = useMemo(() => {
    const routes = new Set<string>();
    for (const e of entries) {
      if (e.route) routes.add(e.route);
    }
    return Array.from(routes).sort();
  }, [entries]);

  // Download the full log file
  const handleDownload = useCallback(async () => {
    setDownloading(true);
    try {
      const res = await fetch("/api/logs/download");
      if (!res.ok) {
        setError(`Download failed: HTTP ${res.status}`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      // Use the filename from Content-Disposition if available
      const cd = res.headers.get("Content-Disposition") || "";
      const match = cd.match(/filename="?([^"]+)"?/);
      a.download = match ? match[1] : `dashboard-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  }, []);

  // Clear logs
  const handleClear = useCallback(async () => {
    setClearing(true);
    try {
      const res = await fetch("/api/logs", { method: "DELETE" });
      if (!res.ok) {
        setError(`Clear failed: HTTP ${res.status}`);
        return;
      }
      setEntries([]);
      setTotalEntries(0);
      setConfirmingClear(false);
      await fetchLogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setClearing(false);
    }
  }, [fetchLogs]);

  // Copy all visible entries to clipboard
  const handleCopy = useCallback(async () => {
    const text = visibleEntries
      .map(e => {
        const ts = e.timestamp;
        const lvl = e.level.padEnd(5);
        const route = e.route ? ` [${e.route}]` : "";
        const data = e.data ? ` ${JSON.stringify(e.data)}` : "";
        const stack = e.stack ? `\n  ${e.stack}` : "";
        return `${ts} ${lvl}${route} ${e.message}${data}${stack}`;
      })
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    }
  }, [visibleEntries]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      {/* Top bar */}
      <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-3 sm:px-4 py-3 flex items-center gap-2 sm:gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push("/")}
            className="gap-1.5 text-slate-300 hover:text-white"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="hidden sm:inline">Back to Dashboard</span>
            <span className="sm:hidden">Back</span>
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Terminal className="w-5 h-5 text-emerald-400" />
            <h1 className="text-base sm:text-xl font-bold tracking-tight">
              Server Logs
            </h1>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-3 sm:px-4 py-4 flex-1 flex flex-col gap-3">
        {/* Controls */}
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4 pb-4 space-y-3">
            {/* Row 1: Level chips + search */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Level filter chips */}
              <div className="flex flex-wrap gap-1">
                {LEVELS.map((lvl) => (
                  <button
                    key={lvl}
                    onClick={() => setLevelFilter(lvl)}
                    className={cn(
                      "px-2.5 py-1 rounded-md text-xs font-medium transition-colors",
                      levelFilter === lvl
                        ? "bg-emerald-600 text-white"
                        : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                    )}
                  >
                    {lvl}
                  </button>
                ))}
              </div>

              {/* Search */}
              <div className="relative flex-1 min-w-[160px] sm:min-w-[240px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <Input
                  placeholder="Search logs..."
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="pl-10 bg-slate-950 border-slate-700 text-slate-100 placeholder-slate-500"
                />
              </div>
            </div>

            {/* Row 2: Route filter + toggles + actions */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Route filter */}
              <Select value={routeFilter} onValueChange={setRouteFilter}>
                <SelectTrigger className="w-[200px] sm:w-[280px] h-8 bg-slate-950 border-slate-700 text-slate-100">
                  <Filter className="w-3.5 h-3.5 mr-1.5 text-slate-500" />
                  <SelectValue placeholder="All routes" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All routes ({allRoutes.length})</SelectItem>
                  {allRoutes.map((r) => (
                    <SelectItem key={r} value={r}>{r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Auto-refresh toggle */}
              <Button
                variant={autoRefresh ? "default" : "outline"}
                size="sm"
                onClick={() => setAutoRefresh(!autoRefresh)}
                className="h-8 text-xs gap-1.5"
                title="Toggle live auto-refresh (2s poll)"
              >
                {autoRefresh ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                {autoRefresh ? "Pause" : "Live"}
              </Button>

              {/* Auto-scroll toggle */}
              <Button
                variant={autoScroll ? "default" : "outline"}
                size="sm"
                onClick={() => setAutoScroll(!autoScroll)}
                className="h-8 text-xs gap-1.5"
                title="Toggle auto-scroll to newest entries"
              >
                <RefreshCw className={cn("w-3.5 h-3.5", autoScroll && "animate-pulse")} />
                Auto-scroll
              </Button>

              {/* Manual refresh */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchLogs()}
                disabled={loading}
                className="h-8 text-xs gap-1.5 bg-slate-950 border-slate-700 text-slate-200"
              >
                {loading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                Refresh
              </Button>

              {/* Copy */}
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopy}
                disabled={visibleEntries.length === 0}
                className="h-8 text-xs gap-1.5 bg-slate-950 border-slate-700 text-slate-200"
                title="Copy all visible entries to clipboard"
              >
                Copy
              </Button>

              {/* Download */}
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownload}
                disabled={downloading}
                className="h-8 text-xs gap-1.5 bg-slate-950 border-slate-700 text-slate-200"
                title="Download the FULL log file (includes history beyond the in-memory buffer)"
              >
                {downloading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Download className="w-3.5 h-3.5" />
                )}
                <span className="hidden sm:inline">Download</span>
              </Button>

              {/* Clear (with confirmation) */}
              {!confirmingClear ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmingClear(true)}
                  className="h-8 text-xs gap-1.5 bg-red-950/30 border-red-800 text-red-300 hover:bg-red-950/50"
                  title="Clear all logs (in-memory + disk)"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Clear</span>
                </Button>
              ) : (
                <div className="flex items-center gap-1.5 bg-red-950/50 border border-red-800 rounded-md p-1">
                  <span className="text-xs text-red-300 px-2">Sure?</span>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleClear}
                    disabled={clearing}
                    className="h-6 text-xs"
                  >
                    {clearing ? <Loader2 className="w-3 h-3 animate-spin" /> : "Yes, clear"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmingClear(false)}
                    className="h-6 text-xs text-slate-300"
                  >
                    Cancel
                  </Button>
                </div>
              )}

              {/* Status indicator */}
              <div className="ml-auto text-xs text-slate-400 flex items-center gap-2">
                {lastFetch && (
                  <span>Updated {new Date(lastFetch).toLocaleTimeString(undefined, { hour12: false })}</span>
                )}
                {autoRefresh && sseConnected && (
                  <span className="flex items-center gap-1 text-emerald-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    LIVE (SSE)
                  </span>
                )}
                {autoRefresh && !sseConnected && (
                  <span className="flex items-center gap-1 text-amber-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                    Connecting…
                  </span>
                )}
              </div>
            </div>

            {/* Error */}
            {error && (
              <div className="p-2 rounded-md bg-red-950/40 border border-red-800 text-red-300 text-xs">
                {error}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Stats bar */}
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-400">
          <span>
            Showing <span className="text-slate-200 font-semibold tabular-nums">{visibleEntries.length}</span> of{" "}
            <span className="text-slate-200 font-semibold tabular-nums">{totalEntries}</span> entries
          </span>
          {allRoutes.length > 0 && (
            <span>· {allRoutes.length} unique routes</span>
          )}
          {routeFilter !== "ALL" && (
            <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-slate-700 text-slate-300">
              Filter: {routeFilter}
            </Badge>
          )}
          {debouncedSearch && (
            <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-slate-700 text-slate-300">
              Search: "{debouncedSearch}"
            </Badge>
          )}
        </div>

        {/* Log terminal */}
        <Card className="bg-slate-950 border-slate-800 flex-1 flex flex-col min-h-[400px]">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed"
            style={{ maxHeight: "calc(100vh - 320px)" }}
          >
            {visibleEntries.length === 0 ? (
              <div className="text-slate-600 italic text-center py-12">
                {loading ? (
                  <span className="flex items-center gap-2 justify-center">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading logs...
                  </span>
                ) : (
                  <>
                    <Terminal className="w-10 h-10 mx-auto mb-3 opacity-30" />
                    <p className="font-medium">No log entries match the current filters</p>
                    <p className="text-xs mt-1">
                      Try changing the level filter, clearing the search, or waiting for new activity.
                    </p>
                  </>
                )}
              </div>
            ) : (
              visibleEntries.map((entry, idx) => (
                <div
                  key={`${entry.timestamp}-${idx}`}
                  className={cn(
                    "mb-1 p-2 rounded border-l-2 break-all",
                    LEVEL_BG[entry.level] || "bg-slate-900/40 border-slate-700"
                  )}
                >
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-slate-500 tabular-nums flex-shrink-0">
                      {formatTime(entry.timestamp)}
                    </span>
                    <span className={cn("font-bold flex-shrink-0", LEVEL_COLORS[entry.level])}>
                      [{entry.level}]
                    </span>
                    {entry.route && (
                      <span className="text-purple-400 text-[10px] flex-shrink-0">
                        {entry.route}
                      </span>
                    )}
                    {entry.durationMs !== undefined && (
                      <span className="text-cyan-400 text-[10px] flex-shrink-0 tabular-nums">
                        {entry.durationMs}ms
                      </span>
                    )}
                    {entry.requestId && (
                      <span className="text-slate-600 text-[10px] flex-shrink-0">
                        #{entry.requestId}
                      </span>
                    )}
                  </div>
                  <div className={cn("mt-0.5", LEVEL_COLORS[entry.level])}>
                    {entry.message}
                  </div>
                  {entry.data && (
                    <pre className="mt-1 text-[10px] text-slate-400 whitespace-pre-wrap break-all">
                      {(() => {
                        try {
                          return JSON.stringify(entry.data, null, 2);
                        } catch {
                          return String(entry.data);
                        }
                      })()}
                    </pre>
                  )}
                  {entry.stack && (
                    <pre className="mt-1 text-[10px] text-red-400/70 whitespace-pre-wrap break-all">
                      {entry.stack}
                    </pre>
                  )}
                </div>
              ))
            )}
          </div>
        </Card>

        {/* Help text */}
        <div className="text-xs text-slate-500 text-center">
          Logs are stored both in memory (last 2000 entries) and on disk (.dashboard.log).
          Click <strong className="text-slate-300">Download</strong> to get the full on-disk file.
        </div>
      </main>
    </div>
  );
}

// Need useMemo import — already imported at top of file

export default function LogsPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-slate-950">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
        </div>
      }
    >
      <LogsContent />
    </Suspense>
  );
}
