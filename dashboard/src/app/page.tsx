'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CheckCircle2, XCircle, AlertCircle, Clock, Users, RefreshCw, Search,
  Loader2, FileText, Activity, Ban, Lock, ShieldAlert, Eye, EyeOff,
  ChevronDown, Filter, ExternalLink, Bug, Play, Square, Terminal, Settings,
  Github, Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// ============================================================
// Types
// ============================================================

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

interface CsvFile {
  name: string;
  path: string;
  size: number;
  lastModified: string;
  isStatusFile: boolean;
  inputFileName: string | null;
}

// ============================================================
// Status configuration
// ============================================================

type StatusCategory = "done" | "terminal" | "retryable" | "pending";

interface StatusInfo {
  label: string;
  category: StatusCategory;
  color: string;
  bg: string;
  border: string;
  icon: typeof CheckCircle2;
  description: string;
}

const STATUS_CONFIG: Record<string, StatusInfo> = {
  subscribed: {
    label: "Subscribed", category: "done",
    color: "text-emerald-700 dark:text-emerald-300",
    bg: "bg-emerald-50 dark:bg-emerald-950/40",
    border: "border-emerald-200 dark:border-emerald-800",
    icon: CheckCircle2, description: "Successfully subscribed this run",
  },
  already_subscribed: {
    label: "Already Joined", category: "done",
    color: "text-sky-700 dark:text-sky-300",
    bg: "bg-sky-50 dark:bg-sky-950/40",
    border: "border-sky-200 dark:border-sky-800",
    icon: CheckCircle2, description: "Was already subscribed before this run",
  },
  failed: {
    label: "Failed", category: "retryable",
    color: "text-amber-700 dark:text-amber-300",
    bg: "bg-amber-50 dark:bg-amber-950/40",
    border: "border-amber-200 dark:border-amber-800",
    icon: AlertCircle, description: "Could not subscribe (network error, button not found, etc.)",
  },
  not_found: {
    label: "Not Found", category: "terminal",
    color: "text-stone-700 dark:text-stone-300",
    bg: "bg-stone-50 dark:bg-stone-900/40",
    border: "border-stone-200 dark:border-stone-800",
    icon: XCircle, description: "Subreddit doesn't exist (404)",
  },
  banned: {
    label: "Banned", category: "terminal",
    color: "text-red-700 dark:text-red-300",
    bg: "bg-red-50 dark:bg-red-950/40",
    border: "border-red-200 dark:border-red-800",
    icon: Ban, description: "Subreddit is banned by Reddit",
  },
  private: {
    label: "Private", category: "terminal",
    color: "text-purple-700 dark:text-purple-300",
    bg: "bg-purple-50 dark:bg-purple-950/40",
    border: "border-purple-200 dark:border-purple-800",
    icon: Lock, description: "Subreddit is invite-only",
  },
  quarantined: {
    label: "Quarantined", category: "terminal",
    color: "text-orange-700 dark:text-orange-300",
    bg: "bg-orange-50 dark:bg-orange-950/40",
    border: "border-orange-200 dark:border-orange-800",
    icon: ShieldAlert, description: "Requires opt-in via web UI",
  },
  shadowbanned: {
    label: "Shadowbanned", category: "retryable",
    color: "text-rose-700 dark:text-rose-300",
    bg: "bg-rose-50 dark:bg-rose-950/40",
    border: "border-rose-200 dark:border-rose-800",
    icon: ShieldAlert, description: "Account got shadowbanned mid-run",
  },
  aborted: {
    label: "Aborted", category: "retryable",
    color: "text-pink-700 dark:text-pink-300",
    bg: "bg-pink-50 dark:bg-pink-950/40",
    border: "border-pink-200 dark:border-pink-800",
    icon: Ban, description: "Session ended early",
  },
  pending: {
    label: "Pending", category: "pending",
    color: "text-slate-700 dark:text-slate-300",
    bg: "bg-slate-50 dark:bg-slate-900/40",
    border: "border-slate-200 dark:border-slate-800",
    icon: Clock, description: "Not yet processed",
  },
};

function getStatusInfo(status: string): StatusInfo {
  const normalized = (status || "pending").trim().toLowerCase() || "pending";
  return STATUS_CONFIG[normalized] ?? STATUS_CONFIG.pending;
}

// ============================================================
// Helpers
// ============================================================

function formatNumber(n: string | undefined): string {
  if (!n) return "—";
  const num = parseInt(n, 10);
  if (isNaN(num)) return n; // not a number — return as-is (could be "~X weekly active")
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1) + "K";
  return num.toString();
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return "never";
  try {
    const d = new Date(iso);
    const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
    if (seconds < 5) return "just now";
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  } catch {
    return "unknown";
  }
}

function formatCreatedDate(created: string | undefined): string {
  if (!created) return "—";
  // Could be epoch float or ISO string
  const num = parseFloat(created);
  if (!isNaN(num) && num > 0) {
    // epoch seconds (could be float)
    const d = new Date(num * 1000);
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    }
  }
  // try ISO
  try {
    const d = new Date(created);
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    }
  } catch {}
  return created;
}

// ============================================================
// Main Component
// ============================================================

export default function Home() {
  const [csvData, setCsvData] = useState<CsvData | null>(null);
  const [csvFiles, setCsvFiles] = useState<CsvFile[]>([]);
  const [selectedCsv, setSelectedCsv] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const [search, setSearch] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [nsfwFilter, setNsfwFilter] = useState<"all" | "sfw" | "nsfw">("all");

  // Settings state
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [settings, setSettings] = useState<{ csvRoot: string; pythonCmd: string; githubRepo?: string; githubPat?: string; autoUpdate?: boolean }>({ csvRoot: "", pythonCmd: "" });
  const [settingsStatus, setSettingsStatus] = useState<{ dirExists: boolean; csvCount: number; csvFiles: string[] } | null>(null);
  const [settingsInput, setSettingsInput] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);

  // GitHub settings inputs
  const [githubRepoInput, setGithubRepoInput] = useState("");
  const [githubPatInput, setGithubPatInput] = useState("");
  const [autoUpdateEnabled, setAutoUpdateEnabled] = useState(false);
  const [savingGithub, setSavingGithub] = useState(false);

  // Auto-update status
  const [updateStatus, setUpdateStatus] = useState<any>(null);
  const [lastUpdateCheck, setLastUpdateCheck] = useState<Date | null>(null);
  const [updateNotification, setUpdateNotification] = useState<string | null>(null);

  // CSV upload state
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Debug panel state
  const [showDebug, setShowDebug] = useState<boolean>(false);
  const [debugInfo, setDebugInfo] = useState<any>(null);
  const [debugLoading, setDebugLoading] = useState<boolean>(false);
  const [csvListDebug, setCsvListDebug] = useState<any>(null);

  // Fetch the list of CSV files
  const fetchCsvList = useCallback(async () => {
    setListError(null);
    try {
      const res = await fetch("/api/csv-list");
      const data = await res.json();
      // Always capture debug info if present
      if (data.debug) {
        setCsvListDebug(data.debug);
      }
      if (!res.ok) {
        setListError(data.error || `HTTP ${res.status}`);
        setCsvFiles([]);
        return;
      }
      const files: CsvFile[] = data.files || [];
      setCsvFiles(files);
      // If we don't have a selection yet, pick the first file
      // (the API returns status files first). This means we'll prefer
      // .status.csv files over the bare input .csv files.
      if (files.length > 0) {
        setSelectedCsv((current) => {
          if (current && files.some((f) => f.name === current)) {
            return current; // keep current selection if still valid
          }
          return files[0].name;
        });
      }
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
      setCsvFiles([]);
    }
  }, []);

  // Fetch the CSV data
  const fetchCsvData = useCallback(async (csv: string) => {
    if (!csv) return;
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch(`/api/csv-data?csv=${encodeURIComponent(csv)}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        setCsvData(null);
      } else {
        setCsvData(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCsvData(null);
    } finally {
      setRefreshing(false);
      setLastFetch(new Date());
    }
  }, []);

  // Fetch debug info from /api/debug
  const fetchDebugInfo = useCallback(async () => {
    setDebugLoading(true);
    try {
      const res = await fetch("/api/debug");
      const data = await res.json();
      setDebugInfo(data);
    } catch (err) {
      setDebugInfo({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setDebugLoading(false);
    }
  }, []);

  // Fetch settings from /api/settings
  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) return;
      const data = await res.json();
      setSettings(data.config);
      setSettingsStatus(data.status);
      setSettingsInput(data.config.csvRoot || "");
      setGithubRepoInput(data.config.githubRepo || "");
      setGithubPatInput(data.config.githubPat || ""); // masked — user can leave as-is to keep
      setAutoUpdateEnabled(Boolean(data.config.autoUpdate));
    } catch {}
  }, []);

  // Save settings
  const saveSettings = useCallback(async (csvRoot: string, pythonCmd?: string) => {
    setSavingSettings(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvRoot, pythonCmd }),
      });
      const data = await res.json();
      if (data.ok) {
        setSettings(data.config);
        setSettingsStatus(data.status);
      }
    } catch {} finally {
      setSavingSettings(false);
    }
  }, []);

  // Save GitHub settings
  const saveGithubSettings = useCallback(async (repo: string, pat: string, autoUpdate: boolean) => {
    setSavingGithub(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          githubRepo: repo,
          githubPat: pat,
          autoUpdate,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setSettings(data.config);
        setGithubPatInput(data.config.githubPat || ""); // masked
      }
    } catch {} finally {
      setSavingGithub(false);
    }
  }, []);

  // Check for updates (manual trigger)
  const checkForUpdates = useCallback(async () => {
    try {
      const res = await fetch("/api/auto-update", { method: "POST" });
      const data = await res.json();
      setUpdateStatus(data);
      setLastUpdateCheck(new Date());
      if (data.updated) {
        const fileCount = data.changedFiles?.length || 0;
        const commitCount = data.commitLog?.length || 0;
        let msg = `Pulled ${commitCount} commit${commitCount === 1 ? "" : "s"} (${fileCount} file${fileCount === 1 ? "" : "s"} changed).`;
        if (data.dashboardCodeChanged) msg += " Dashboard updated (HMR will reload automatically).";
        if (data.pythonScriptChanged) msg += " Subscriber script updated — restart the run to use the new code.";
        if (data.nextConfigChanged) msg += " next.config.ts changed — restart the dashboard to apply.";
        if (data.nodeDepsInstalled) msg += " Node deps reinstalled.";
        if (data.pythonDepsInstalled) msg += " Python deps reinstalled.";
        setUpdateNotification(msg);
        // Auto-clear notification after 30 seconds
        setTimeout(() => setUpdateNotification(null), 30000);
      } else if (data.error) {
        setUpdateNotification(`Update error: ${data.error}`);
        setTimeout(() => setUpdateNotification(null), 30000);
      }
    } catch (err) {
      setUpdateNotification(`Failed to check for updates: ${err}`);
      setTimeout(() => setUpdateNotification(null), 30000);
    }
  }, []);

  // Handle CSV file upload (import from another device)
  const handleFileUpload = useCallback(async (file: File) => {
    setUploading(true);
    setUploadResult(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/csv-upload", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        setUploadResult({ error: data.error || `HTTP ${res.status}` });
      } else {
        setUploadResult(data);
        // Refresh the CSV list so the new file appears in the dropdown
        await fetchCsvList();
        // Auto-select the newly uploaded file
        if (data.filename) {
          setSelectedCsv(data.filename);
        }
      }
    } catch (err) {
      setUploadResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setUploading(false);
    }
  }, [fetchCsvList]);

  // Initial load — fetch settings first, then CSV list
  useEffect(() => {
    fetchSettings().then(() => fetchCsvList());
  }, [fetchSettings, fetchCsvList]);

  // Poll GitHub for updates every 60 seconds when autoUpdate is enabled.
  // The /api/auto-update route does the actual fetch + pull.
  // Next.js dev server HMR will auto-reload the frontend when files change.
  useEffect(() => {
    if (!settings.autoUpdate || !settings.githubRepo) return;

    // Initial check 5 seconds after mount
    const initialTimer = setTimeout(checkForUpdates, 5000);

    // Then every 60 seconds
    const interval = setInterval(checkForUpdates, 60000);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [settings.autoUpdate, settings.githubRepo, checkForUpdates]);

  useEffect(() => {
    if (!selectedCsv) return; // wait for fetchCsvList to pick one
    fetchCsvData(selectedCsv);
  }, [selectedCsv, fetchCsvData]);

  // Auto-refresh every 5 seconds — BUT also refresh on tab focus
  // because browsers throttle setInterval when the tab is in the
  // background (especially on mobile). This way, when you switch
  // back to the dashboard tab, it grabs the latest data immediately.
  useEffect(() => {
    if (!autoRefresh || !selectedCsv) return;

    // Refresh immediately when the tab becomes visible again
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        fetchCsvData(selectedCsv);
      }
    };
    // Also refresh when the window regains focus (covers cases where
    // visibilitychange doesn't fire on some mobile browsers)
    const handleFocus = () => fetchCsvData(selectedCsv);

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleFocus);

    const interval = setInterval(() => {
      // Only fetch if the tab is actually visible — otherwise the
      // browser will just queue the request and the user will see
      // a flood of updates when they return.
      if (document.visibilityState === "visible") {
        fetchCsvData(selectedCsv);
      }
    }, 3000); // Poll every 3 seconds (down from 5) for snappier updates

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleFocus);
      clearInterval(interval);
    };
  }, [autoRefresh, selectedCsv, fetchCsvData]);

  // Derived stats
  const stats = useMemo(() => {
    if (!csvData) {
      return { total: 0, done: 0, failed: 0, pending: 0, terminal: 0 };
    }
    const counts = csvData.counts || {};
    const total = csvData.totalRows;
    const done = (counts.subscribed || 0) + (counts.already_subscribed || 0);
    const failed = (counts.failed || 0) + (counts.shadowbanned || 0) + (counts.aborted || 0);
    const pending = counts.pending || 0;
    const terminal =
      (counts.not_found || 0) + (counts.banned || 0) +
      (counts.private || 0) + (counts.quarantined || 0);
    return { total, done, failed, pending, terminal };
  }, [csvData]);

  // Filtered rows for the table
  const filteredRows = useMemo(() => {
    if (!csvData) return [];
    return csvData.rows.filter((row) => {
      const subCol = csvData.subCol || "subreddit";
      const name = (row[subCol] || "").toLowerCase();
      // search
      if (search && !name.includes(search.toLowerCase())) return false;
      // status filter
      if (statusFilter !== "all") {
        const status = (row.status || "pending").trim().toLowerCase() || "pending";
        const category = STATUS_CONFIG[status]?.category || "pending";
        if (statusFilter === "done" && category !== "done") return false;
        if (statusFilter === "failed" && category !== "retryable") return false;
        if (statusFilter === "terminal" && category !== "terminal") return false;
        if (statusFilter === "pending" && status !== "pending") return false;
      }
      // NSFW filter
      if (nsfwFilter !== "all") {
        const nsfw = (row.is_nsfw || "").toLowerCase() === "true";
        if (nsfwFilter === "nsfw" && !nsfw) return false;
        if (nsfwFilter === "sfw" && nsfw) return false;
      }
      return true;
    });
  }, [csvData, search, statusFilter, nsfwFilter]);

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-slate-50 via-white to-slate-100 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
      {/* Header */}
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4 flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center text-white shadow-md">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
                Reddit Subscriber Dashboard
              </h1>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Live status monitor for the browser subscriber script
              </p>
            </div>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-3">
            {/* CSV selector */}
            <Select value={selectedCsv} onValueChange={setSelectedCsv}>
              <SelectTrigger className="w-[280px]">
                <FileText className="w-4 h-4 mr-2 text-slate-500" />
                <SelectValue placeholder="Select CSV" />
              </SelectTrigger>
              <SelectContent>
                {csvFiles.length === 0 ? (
                  <SelectItem value={selectedCsv || "none"} disabled>
                    No CSVs found
                  </SelectItem>
                ) : (
                  csvFiles.map((f) => (
                    <SelectItem key={f.path} value={f.name}>
                      <span className="font-medium">{f.name}</span>
                      <span className="ml-2 text-xs text-slate-500">
                        {(f.size / 1024).toFixed(1)}KB
                      </span>
                      {f.isStatusFile && (
                        <Badge
                          variant="outline"
                          className="ml-2 py-0 px-1.5 text-[10px] border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300"
                        >
                          STATUS
                        </Badge>
                      )}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>

            {/* Auto-refresh toggle */}
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <Switch
                checked={autoRefresh}
                onCheckedChange={setAutoRefresh}
                id="auto-refresh"
              />
              <Label htmlFor="auto-refresh" className="text-xs cursor-pointer">
                Auto-refresh
              </Label>
              {autoRefresh && (
                <span className="text-xs text-slate-500 ml-1">5s</span>
              )}
            </div>

            {/* Manual refresh */}
            <Button
              variant="outline"
              size="icon"
              onClick={() => fetchCsvData(selectedCsv)}
              disabled={refreshing}
              title="Refresh now"
            >
              <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
            </Button>

            {/* Import CSV — upload from another device */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.status.csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  handleFileUpload(file);
                }
                // Reset the input so the same file can be selected again
                e.target.value = "";
              }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              title="Upload a CSV file from this device to the Pi"
              className="gap-1.5"
            >
              {uploading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              Import CSV
            </Button>

            {/* Settings button */}
            <Button
              variant="outline"
              size="icon"
              onClick={() => {
                setShowSettings(!showSettings);
                if (!showSettings) fetchSettings();
              }}
              title="Settings — set CSV directory, Python path, and GitHub auto-update"
              className={cn(showSettings && "bg-blue-100 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700")}
            >
              <Settings className="w-4 h-4" />
              {settings.autoUpdate && settings.githubRepo && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-500 border border-white dark:border-slate-900 animate-pulse" />
              )}
            </Button>

            {/* Debug button */}
            <Button
              variant="outline"
              size="icon"
              onClick={() => {
                setShowDebug(!showDebug);
                if (!showDebug) fetchDebugInfo();
              }}
              title="Toggle debug panel"
              className={cn(showDebug && "bg-orange-100 dark:bg-orange-900/30 border-orange-300 dark:border-orange-700")}
            >
              <Bug className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Last fetch indicator */}
        <div className="container mx-auto px-4 pb-2 flex items-center gap-2 text-xs text-slate-500">
          {lastFetch && (
            <>
              <span>Last updated {formatRelativeTime(lastFetch.toISOString())}</span>
              {csvData?.lastModified && (
                <>
                  <span>·</span>
                  <span>CSV modified {formatRelativeTime(csvData.lastModified)}</span>
                </>
              )}
              {csvData && (
                <>
                  <span>·</span>
                  <span className="font-mono">{csvData.csvPath}</span>
                </>
              )}
            </>
          )}
        </div>
      </header>

      {/* Main content */}
      <main className="container mx-auto px-4 py-6 flex-1 flex flex-col gap-6">
        {/* Settings panel */}
        {showSettings && (
          <Card className="border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Settings className="w-4 h-4" />
                Settings
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                <div>
                  <Label className="text-sm font-medium">CSV Directory</Label>
                  <p className="text-xs text-slate-500 mb-2">
                    The absolute path to the directory containing your CSV files and
                    <code className="font-mono"> reddit_browser_subscriber.py</code>.
                  </p>
                  <div className="flex gap-2">
                    <Input
                      value={settingsInput}
                      onChange={(e) => setSettingsInput(e.target.value)}
                      placeholder="/home/user/reddit_subscriber_package"
                      className="flex-1"
                    />
                    <Button
                      onClick={() => {
                        saveSettings(settingsInput).then(() => fetchCsvList());
                      }}
                      disabled={savingSettings || !settingsInput}
                    >
                      {savingSettings ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save & Reload"}
                    </Button>
                  </div>
                </div>

                <div>
                  <Label className="text-sm font-medium">Python Command</Label>
                  <p className="text-xs text-slate-500 mb-2">
                    The Python executable to use when running the subscriber script.
                  </p>
                  <div className="flex gap-2">
                    <Input
                      value={settings.pythonCmd}
                      onChange={(e) => setSettings({ ...settings, pythonCmd: e.target.value })}
                      placeholder="python3"
                      className="w-40"
                    />
                    <Button
                      variant="outline"
                      onClick={() => saveSettings(settings.csvRoot, settings.pythonCmd)}
                      disabled={savingSettings}
                    >
                      Save Python
                    </Button>
                  </div>
                </div>

                {/* Status display */}
                {settingsStatus && (
                  <div className="p-3 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1 text-sm">
                    <div className="flex items-center gap-2">
                      {settingsStatus.dirExists ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                      ) : (
                        <XCircle className="w-4 h-4 text-red-500" />
                      )}
                      <span>Directory: {settingsStatus.dirExists ? "exists" : "NOT FOUND"}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <FileText className="w-4 h-4 text-slate-500" />
                      <span>CSV files found: <strong>{settingsStatus.csvCount}</strong></span>
                    </div>
                    {settingsStatus.csvFiles.length > 0 && (
                      <div className="ml-6 text-xs text-slate-500">
                        {settingsStatus.csvFiles.map((f, i) => (
                          <div key={i}>• {f}</div>
                        ))}
                      </div>
                    )}
                    {settingsStatus.csvCount === 0 && settingsStatus.dirExists && (
                      <p className="ml-6 text-xs text-amber-600">
                        Directory exists but no .csv files found. Make sure your CSV files
                        are in the directory you specified.
                      </p>
                    )}
                  </div>
                )}

                <div className="text-xs text-slate-500 border-t border-slate-200 dark:border-slate-800 pt-3">
                  <p><strong>Current CSV Root:</strong> <code className="font-mono">{settings.csvRoot || "(not set)"}</code></p>
                  <p><strong>Python:</strong> <code className="font-mono">{settings.pythonCmd || "(not set)"}</code></p>
                  <p><strong>Platform:</strong> <code className="font-mono">{typeof window !== 'undefined' ? navigator.platform : 'server'}</code></p>
                  <p className="mt-2">After changing the CSV directory, the dropdown above will automatically refresh.</p>
                </div>

                {/* GitHub auto-update section */}
                <div className="border-t border-slate-200 dark:border-slate-800 pt-4 mt-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Github className="w-4 h-4" />
                    <Label className="text-sm font-medium">GitHub Auto-Update</Label>
                    {settings.autoUpdate && settings.githubRepo && (
                      <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300">
                        Active
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-slate-500 mb-3">
                    When enabled, the dashboard polls GitHub every 60 seconds for new commits.
                    If new commits are found, they're pulled automatically and the dashboard
                    hot-reloads. The Python subscriber script picks up changes on the next Start.
                  </p>

                  <div className="space-y-2">
                    <div>
                      <Label className="text-xs">Repository URL</Label>
                      <Input
                        value={githubRepoInput}
                        onChange={(e) => setGithubRepoInput(e.target.value)}
                        placeholder="https://github.com/USERNAME/reddit-subscriber.git"
                        className="mt-1 font-mono text-xs"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Personal Access Token (PAT)</Label>
                      <Input
                        type="password"
                        value={githubPatInput}
                        onChange={(e) => setGithubPatInput(e.target.value)}
                        placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                        className="mt-1 font-mono text-xs"
                      />
                      <p className="text-[10px] text-slate-500 mt-1">
                        Create at github.com/settings/tokens with <code>repo</code> scope.
                        Stored locally in <code>.config.json</code> on the Pi.
                        {githubPatInput.includes("...") && (
                          <span className="text-amber-600 dark:text-amber-400 ml-1">
                            (currently set — leave as-is to keep, or paste a new one to replace)
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={autoUpdateEnabled}
                        onCheckedChange={setAutoUpdateEnabled}
                        id="auto-update-toggle"
                      />
                      <Label htmlFor="auto-update-toggle" className="text-xs cursor-pointer">
                        Auto-pull every 60 seconds
                      </Label>
                    </div>
                    <div className="flex gap-2 pt-1">
                      <Button
                        size="sm"
                        onClick={() => saveGithubSettings(githubRepoInput, githubPatInput, autoUpdateEnabled)}
                        disabled={savingGithub || !githubRepoInput}
                      >
                        {savingGithub ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={checkForUpdates}
                        disabled={!githubRepoInput}
                      >
                        <RefreshCw className="w-3 h-3 mr-1" />
                        Check now
                      </Button>
                    </div>
                  </div>

                  {/* Update status */}
                  {updateStatus && (
                    <div className="mt-3 p-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs space-y-1">
                      <div className="flex items-center gap-2">
                        {updateStatus.error ? (
                          <XCircle className="w-3 h-3 text-red-500" />
                        ) : updateStatus.upToDate ? (
                          <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                        ) : updateStatus.updated ? (
                          <CheckCircle2 className="w-3 h-3 text-blue-500" />
                        ) : (
                          <Clock className="w-3 h-3 text-slate-400" />
                        )}
                        <span>
                          {updateStatus.error ? "Error" :
                           updateStatus.updated ? "Updated" :
                           updateStatus.upToDate ? "Up to date" :
                           "Status"}
                        </span>
                        {lastUpdateCheck && (
                          <span className="text-slate-500 ml-auto">
                            Checked {formatRelativeTime(lastUpdateCheck.toISOString())}
                          </span>
                        )}
                      </div>
                      {updateStatus.currentCommit && (
                        <p className="font-mono text-[10px] text-slate-500">
                          HEAD: {updateStatus.currentCommit.slice(0, 8)}
                          {updateStatus.branch && ` (${updateStatus.branch})`}
                        </p>
                      )}
                      {updateStatus.newCommit && (
                        <p className="font-mono text-[10px] text-emerald-600 dark:text-emerald-400">
                          New HEAD: {updateStatus.newCommit.slice(0, 8)}
                        </p>
                      )}
                      {updateStatus.error && (
                        <p className="text-red-600 dark:text-red-400">{updateStatus.error}</p>
                      )}
                      {updateStatus.commitLog && updateStatus.commitLog.length > 0 && (
                        <div className="text-slate-600 dark:text-slate-400">
                          {updateStatus.commitLog.slice(0, 5).map((c: string, i: number) => (
                            <p key={i} className="font-mono text-[10px]">{c}</p>
                          ))}
                          {updateStatus.commitLog.length > 5 && (
                            <p className="text-[10px] text-slate-500">
                              ...and {updateStatus.commitLog.length - 5} more
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Update notification banner (shows when updates are pulled) */}
        {updateNotification && (
          <Card className="border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/30">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-start gap-3">
                <RefreshCw className="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0 animate-spin" />
                <div className="flex-1">
                  <p className="font-semibold text-blue-700 dark:text-blue-300">Update Applied</p>
                  <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">{updateNotification}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setUpdateNotification(null)}
                  className="text-blue-600 dark:text-blue-400"
                >
                  Dismiss
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Debug panel */}
        {showDebug && (
          <Card className="border-orange-200 dark:border-orange-800 bg-orange-50/50 dark:bg-orange-950/20">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Bug className="w-4 h-4" />
                Debug Diagnostics
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={fetchDebugInfo}
                  disabled={debugLoading}
                  className="ml-auto"
                >
                  {debugLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  Refresh
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {debugInfo && (
                <div className="space-y-2 text-xs font-mono">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <div className="p-2 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                      <p className="font-bold text-slate-700 dark:text-slate-300">Environment</p>
                      <p>Platform: {debugInfo.platform}</p>
                      <p>Node: {debugInfo.nodeVersion}</p>
                      <p>cwd: {debugInfo.cwd}</p>
                    </div>
                    <div className="p-2 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                      <p className="font-bold text-slate-700 dark:text-slate-300">Path Resolution</p>
                      <p>Final root: {debugInfo.pathResolution?.finalRoot}</p>
                      <p>Sandbox fallback exists: {String(debugInfo.pathResolution?.sandboxFallbackExists)}</p>
                    </div>
                  </div>

                  {debugInfo.pathResolution?.steps && (
                    <div className="p-2 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                      <p className="font-bold text-slate-700 dark:text-slate-300">Path walk steps</p>
                      {debugInfo.pathResolution.steps.map((step: string, i: number) => (
                        <p key={i} className="text-slate-600 dark:text-slate-400">{step}</p>
                      ))}
                    </div>
                  )}

                  {debugInfo.directoryListing && (
                    <div className="p-2 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                      <p className="font-bold text-slate-700 dark:text-slate-300">
                        Directory listing ({debugInfo.directoryListing.root})
                      </p>
                      {debugInfo.directoryListing.csvFiles.length > 0 ? (
                        <>
                          <p className="text-emerald-600 dark:text-emerald-400 font-bold">
                            Found {debugInfo.directoryListing.csvFiles.length} CSV files:
                          </p>
                          {debugInfo.directoryListing.csvFiles.map((f: string, i: number) => (
                            <p key={i} className="text-emerald-700 dark:text-emerald-300">  {f}</p>
                          ))}
                        </>
                      ) : (
                        <p className="text-red-600 dark:text-red-400 font-bold">
                          No CSV files found in this directory!
                        </p>
                      )}
                      <p className="mt-2 text-slate-500">All entries ({debugInfo.directoryListing.entries.length}):</p>
                      {debugInfo.directoryListing.entries.map((e: string, i: number) => (
                        <p key={i} className="text-slate-600 dark:text-slate-400">{e}</p>
                      ))}
                    </div>
                  )}

                  {debugInfo.sampleCsvCheck && (
                    <div className="p-2 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                      <p className="font-bold text-slate-700 dark:text-slate-300">Sample CSV check</p>
                      <p>Path: {debugInfo.sampleCsvCheck.path}</p>
                      <p>Exists: {String(debugInfo.sampleCsvCheck.exists)}</p>
                      {debugInfo.sampleCsvCheck.size !== undefined && (
                        <p>Size: {debugInfo.sampleCsvCheck.size} bytes</p>
                      )}
                      {debugInfo.sampleCsvCheck.firstFewLines && (
                        <>
                          <p className="mt-1">First 5 lines:</p>
                          {debugInfo.sampleCsvCheck.firstFewLines.map((line: string, i: number) => (
                            <p key={i} className="text-slate-600 dark:text-slate-400">{line}</p>
                          ))}
                        </>
                      )}
                    </div>
                  )}

                  {debugInfo.errors && debugInfo.errors.length > 0 && (
                    <div className="p-2 rounded bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800">
                      <p className="font-bold text-red-700 dark:text-red-300">Errors</p>
                      {debugInfo.errors.map((e: string, i: number) => (
                        <p key={i} className="text-red-600 dark:text-red-400">{e}</p>
                      ))}
                    </div>
                  )}

                  {csvListDebug && (
                    <div className="p-2 rounded bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                      <p className="font-bold text-slate-700 dark:text-slate-300">CSV list API debug</p>
                      <p>cwd: {csvListDebug.cwd}</p>
                      <p>projectRoot: {csvListDebug.projectRoot}</p>
                      <p>allowedRoot: {csvListDebug.allowedRoot}</p>
                      <p>csvCount: {csvListDebug.csvCount}</p>
                      <p>entries: {csvListDebug.entries?.join(", ")}</p>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Upload result display */}
        {uploadResult && (
          <Card className={
            uploadResult.error
              ? "border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30"
              : "border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30"
          }>
            <CardContent className="pt-6">
              <div className="flex items-start gap-3">
                {uploadResult.error ? (
                  <XCircle className="w-5 h-5 flex-shrink-0 text-red-600 dark:text-red-400" />
                ) : (
                  <CheckCircle2 className="w-5 h-5 flex-shrink-0 text-emerald-600 dark:text-emerald-400" />
                )}
                <div className="flex-1">
                  <p className="font-semibold">
                    {uploadResult.error ? "Upload Failed" : "CSV Imported"}
                  </p>
                  {uploadResult.error ? (
                    <p className="text-sm text-red-600 dark:text-red-400">{uploadResult.error}</p>
                  ) : (
                    <div className="text-sm text-emerald-700 dark:text-emerald-300 space-y-1">
                      <p>{uploadResult.message}</p>
                      <p className="text-xs">
                        <strong>{uploadResult.filename}</strong> · {uploadResult.rows} rows · {(uploadResult.size / 1024).toFixed(1)} KB
                      </p>
                      {uploadResult.isStatusFile && (
                        <p className="text-xs text-emerald-600 dark:text-emerald-400">
                          Status file detected — existing subscription progress will be preserved.
                        </p>
                      )}
                      {uploadResult.hasStatusColumn && uploadResult.statusCounts && Object.keys(uploadResult.statusCounts).length > 0 && (
                        <div className="text-xs mt-1">
                          <span className="text-slate-600 dark:text-slate-400">Status counts:</span>{" "}
                          {Object.entries(uploadResult.statusCounts).map(([status, count]) => (
                            <Badge key={status} variant="outline" className="ml-1 py-0 px-1.5 text-[10px]">
                              {status}: {count as number}
                            </Badge>
                          ))}
                        </div>
                      )}
                      {uploadResult.overwritten && (
                        <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                          Note: a file with this name already existed and was overwritten.
                        </p>
                      )}
                    </div>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setUploadResult(null)}
                  className="text-slate-500"
                >
                  Dismiss
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* List error display */}
        {listError && (
          <Card className="border-orange-200 dark:border-orange-800 bg-orange-50 dark:bg-orange-950/30">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3 text-orange-700 dark:text-orange-300">
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                <div>
                  <p className="font-semibold">Could not list CSV files</p>
                  <p className="text-sm text-orange-600 dark:text-orange-400">{listError}</p>
                  <p className="text-xs mt-1 text-slate-500">
                    Click the bug icon (🐛) in the header to see debug diagnostics.
                    The dashboard is looking for CSV files in the directory that
                    contains <code className="font-mono">reddit_browser_subscriber.py</code>.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* CSV file error display */}
        {error && (
          <Card className="border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3 text-red-700 dark:text-red-300">
                <XCircle className="w-5 h-5 flex-shrink-0" />
                <div>
                  <p className="font-semibold">Error reading CSV</p>
                  <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Run Controls + Live Log Terminal */}
        <RunControls
          selectedCsv={selectedCsv}
          onCsvDataRefresh={() => fetchCsvData(selectedCsv)}
        />

        {/* Stat cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            title="Subscribed"
            value={stats.done}
            total={stats.total}
            icon={CheckCircle2}
            color="text-emerald-600"
            bg="from-emerald-50 to-emerald-100 dark:from-emerald-950/40 dark:to-emerald-900/20"
          />
          <StatCard
            title="Pending"
            value={stats.pending}
            total={stats.total}
            icon={Clock}
            color="text-slate-600 dark:text-slate-400"
            bg="from-slate-50 to-slate-100 dark:from-slate-900/40 dark:to-slate-800/20"
          />
          <StatCard
            title="Failed"
            value={stats.failed}
            total={stats.total}
            icon={AlertCircle}
            color="text-amber-600"
            bg="from-amber-50 to-amber-100 dark:from-amber-950/40 dark:to-amber-900/20"
          />
          <StatCard
            title="Terminal"
            value={stats.terminal}
            total={stats.total}
            icon={XCircle}
            color="text-rose-600"
            bg="from-rose-50 to-rose-100 dark:from-rose-950/40 dark:to-rose-900/20"
          />
        </div>

        {/* Progress bar */}
        {csvData && stats.total > 0 && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">Progress</span>
                  <Badge variant="secondary" className="text-xs">
                    {stats.done + stats.terminal} / {stats.total} resolved
                  </Badge>
                </div>
                <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                  {((stats.done + stats.terminal) / stats.total * 100).toFixed(1)}%
                </span>
              </div>
              <div className="h-3 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden flex">
                {/* Done */}
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div
                        className="h-full bg-emerald-500 transition-all duration-500"
                        style={{ width: `${(stats.done / stats.total) * 100}%` }}
                      />
                    </TooltipTrigger>
                    <TooltipContent>Subscribed: {stats.done}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                {/* Terminal */}
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div
                        className="h-full bg-rose-500 transition-all duration-500"
                        style={{ width: `${(stats.terminal / stats.total) * 100}%` }}
                      />
                    </TooltipTrigger>
                    <TooltipContent>Terminal (banned/private/etc.): {stats.terminal}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                {/* Failed */}
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div
                        className="h-full bg-amber-500 transition-all duration-500"
                        style={{ width: `${(stats.failed / stats.total) * 100}%` }}
                      />
                    </TooltipTrigger>
                    <TooltipContent>Failed: {stats.failed}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                {/* Pending (rest) */}
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div
                        className="h-full bg-slate-300 dark:bg-slate-700 transition-all duration-500"
                        style={{ width: `${(stats.pending / stats.total) * 100}%` }}
                      />
                    </TooltipTrigger>
                    <TooltipContent>Pending: {stats.pending}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Status legend */}
        {csvData && (
          <div className="flex flex-wrap gap-2">
            {Object.entries(csvData.counts || {})
              .sort((a, b) => (b[1] as number) - (a[1] as number))
              .map(([status, count]) => {
                const info = getStatusInfo(status);
                const Icon = info.icon;
                return (
                  <Badge
                    key={status}
                    variant="outline"
                    className={cn("gap-1.5 py-1.5 px-3", info.color, info.bg, info.border)}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span className="font-medium">{info.label}</span>
                    <span className="ml-1 font-bold">{count as number}</span>
                  </Badge>
                );
              })}
          </div>
        )}

        {/* Filters */}
        {/* suppressHydrationWarning: some password-manager extensions
            (ProtonPass, LastPass, Bitwarden) inject attributes into this
            div (e.g. data-protonpass-form) after server render but before
            React hydrates. Suppress the resulting hydration warning —
            it's not a real bug, just an extension side-effect. */}
        <div className="flex flex-wrap gap-3 items-center" suppressHydrationWarning>
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <Input
              placeholder="Search subreddits..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[160px]">
              <Filter className="w-4 h-4 mr-2 text-slate-500" />
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="done">Subscribed</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="terminal">Terminal</SelectItem>
            </SelectContent>
          </Select>
          <Select value={nsfwFilter} onValueChange={(v) => setNsfwFilter(v as typeof nsfwFilter)}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="All content" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All content</SelectItem>
              <SelectItem value="sfw">SFW only</SelectItem>
              <SelectItem value="nsfw">NSFW only</SelectItem>
            </SelectContent>
          </Select>
          <div className="text-xs text-slate-500 ml-auto">
            Showing {filteredRows.length} of {csvData?.totalRows ?? 0}
          </div>
        </div>

        {/* Subreddit table */}
        <Card className="flex-1 flex flex-col min-h-[400px]">
          <CardHeader className="border-b border-slate-200 dark:border-slate-800 py-3">
            <CardTitle className="text-base">Subreddits</CardTitle>
          </CardHeader>
          <CardContent className="p-0 flex-1 flex flex-col overflow-hidden">
            {/* Native scroll container — works on all devices (touch + mouse) */}
            <div
              className="flex-1 overflow-auto"
              style={{
                maxHeight: "60vh",
                WebkitOverflowScrolling: "touch",
              }}
            >
              <div className="w-full">
                <table className="w-full text-sm border-collapse">
                  <thead className="sticky top-0 bg-white dark:bg-slate-950 z-10 border-b border-slate-200 dark:border-slate-800">
                    <tr className="text-left">
                      <th className="px-4 py-2.5 font-semibold text-slate-700 dark:text-slate-300">Subreddit</th>
                      <th className="px-4 py-2.5 font-semibold text-slate-700 dark:text-slate-300">Status</th>
                      <th className="px-4 py-2.5 font-semibold text-slate-700 dark:text-slate-300 text-right">Members</th>
                      <th className="px-4 py-2.5 font-semibold text-slate-700 dark:text-slate-300">Description</th>
                      <th className="px-4 py-2.5 font-semibold text-slate-700 dark:text-slate-300">Subscribed At</th>
                      <th className="px-4 py-2.5 font-semibold text-slate-700 dark:text-slate-300">Verified</th>
                      <th className="px-4 py-2.5 font-semibold text-slate-700 dark:text-slate-300">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    <AnimatePresence mode="popLayout">
                      {filteredRows.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="text-center py-12 text-slate-500">
                            {csvData ? "No rows match the current filters." : "No CSV loaded."}
                          </td>
                        </tr>
                      ) : (
                        filteredRows.map((row, idx) => {
                          const subCol = csvData?.subCol || "subreddit";
                          const name = row[subCol] || "";
                          const status = (row.status || "pending").trim() || "pending";
                          const info = getStatusInfo(status);
                          const StatusIcon = info.icon;
                          const nsfw = (row.is_nsfw || "").toLowerCase() === "true";
                          const verified = (row.verified || "").toLowerCase() === "verified";
                          const hasError = !!row.error;
                          const iconUrl = row.icon_url;
                          const error = row.error || "";

                          return (
                            <motion.tr
                              key={`${name}-${idx}`}
                              initial={{ opacity: 0, y: 4 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0 }}
                              transition={{ duration: 0.15 }}
                              className="border-b border-slate-100 dark:border-slate-900 hover:bg-slate-50 dark:hover:bg-slate-900/50 group"
                            >
                              {/* Name */}
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-2.5">
                                  {iconUrl ? (
                                    <img
                                      src={iconUrl}
                                      alt=""
                                      className="w-7 h-7 rounded-full object-cover bg-slate-200 dark:bg-slate-800 flex-shrink-0"
                                      onError={(e) => {
                                        (e.target as HTMLImageElement).style.display = "none";
                                      }}
                                    />
                                  ) : (
                                    <div className="w-7 h-7 rounded-full bg-gradient-to-br from-orange-400 to-red-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                                      {name.charAt(0).toUpperCase()}
                                    </div>
                                  )}
                                  <div className="flex flex-col">
                                    <a
                                      href={`https://www.reddit.com/r/${name}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="font-semibold text-slate-900 dark:text-slate-100 hover:text-orange-600 dark:hover:text-orange-400 transition-colors flex items-center gap-1"
                                    >
                                      r/{name}
                                      <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                                    </a>
                                    {nsfw && (
                                      <Badge variant="outline" className="text-[10px] py-0 px-1.5 w-fit border-rose-300 text-rose-700 dark:border-rose-700 dark:text-rose-300">
                                        NSFW
                                      </Badge>
                                    )}
                                  </div>
                                </div>
                              </td>

                              {/* Status */}
                              <td className="px-4 py-3">
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Badge
                                        variant="outline"
                                        className={cn("gap-1.5", info.color, info.bg, info.border)}
                                      >
                                        <StatusIcon className="w-3 h-3" />
                                        {info.label}
                                      </Badge>
                                    </TooltipTrigger>
                                    <TooltipContent side="top">
                                      <p className="max-w-xs">{info.description}</p>
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              </td>

                              {/* Members */}
                              <td className="px-4 py-3 text-right font-mono text-slate-700 dark:text-slate-300">
                                <div className="flex items-center justify-end gap-1">
                                  <Users className="w-3 h-3 text-slate-400" />
                                  {formatNumber(row.members)}
                                </div>
                              </td>

                              {/* Description */}
                              <td className="px-4 py-3 max-w-xs">
                                <p className="text-xs text-slate-600 dark:text-slate-400 line-clamp-2">
                                  {row.description || "—"}
                                </p>
                              </td>

                              {/* Subscribed At */}
                              <td className="px-4 py-3 text-xs text-slate-600 dark:text-slate-400">
                                {formatTimestamp(row.subscribed_at)}
                              </td>

                              {/* Verified */}
                              <td className="px-4 py-3">
                                {row.verified ? (
                                  <div className="flex items-center gap-1.5">
                                    {verified ? (
                                      <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                                    ) : (
                                      <XCircle className="w-4 h-4 text-rose-500" />
                                    )}
                                    <span className={cn(
                                      "text-xs font-medium",
                                      verified
                                        ? "text-emerald-700 dark:text-emerald-300"
                                        : "text-rose-700 dark:text-rose-300"
                                    )}>
                                      {row.verified}
                                    </span>
                                  </div>
                                ) : (
                                  <span className="text-xs text-slate-400">—</span>
                                )}
                              </td>

                              {/* Error */}
                              <td className="px-4 py-3 max-w-xs">
                                {hasError ? (
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <div className="flex items-center gap-1.5 text-xs text-rose-700 dark:text-rose-300 cursor-help">
                                          <AlertCircle className="w-3 h-3 flex-shrink-0" />
                                          <span className="line-clamp-1">{error}</span>
                                        </div>
                                      </TooltipTrigger>
                                      <TooltipContent side="top" className="max-w-md">
                                        <p className="text-xs">{error}</p>
                                      </TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                ) : (
                                  <span className="text-xs text-slate-400">—</span>
                                )}
                              </td>
                            </motion.tr>
                          );
                        })
                      )}
                    </AnimatePresence>
                  </tbody>
                </table>
              </div>
            </div>
          </CardContent>
        </Card>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur-sm py-4 mt-auto">
        <div className="container mx-auto px-4 flex flex-wrap items-center gap-3 justify-between text-xs text-slate-500">
          <div className="flex items-center gap-2">
            {refreshing ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <CheckCircle2 className="w-3 h-3 text-emerald-500" />
            )}
            <span>
              {refreshing ? "Refreshing..." : "Idle"} · Auto-refresh {autoRefresh ? "on" : "off"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span>Drops to <code className="font-mono px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">/api/csv-data</code> every 5s</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ============================================================
// RunControls + LiveLogTerminal sub-component
// ============================================================

interface RunStatus {
  status: "idle" | "running" | "waiting-for-login" | "completed" | "error" | "stopped";
  pid: number | null;
  startedAt: string | null;
  endedAt: string | null;
  csv: string | null;
  error: string | null;
  logs: { timestamp: string; stream: "stdout" | "stderr"; text: string }[];
  totalLogLines: number;
  scriptPath: string;
  csvRoot: string;
  pythonCmd: string;
  platform: string;
}

function RunControls({
  selectedCsv,
  onCsvDataRefresh,
}: {
  selectedCsv: string;
  onCsvDataRefresh: () => void;
}) {
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [logLines, setLogLines] = useState<
    { timestamp: string; stream: "stdout" | "stderr"; text: string }[]
  >([]);
  const [lastLogIdx, setLastLogIdx] = useState(0);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [options, setOptions] = useState({
    headless: false,
    verifyOnly: false,
    reprocessFailed: false,
    maxSubscribes: 100,
  });
  const [showOptions, setShowOptions] = useState(false);
  const [redditUsername, setRedditUsername] = useState("");
  const [redditPassword, setRedditPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [credentialsSaved, setCredentialsSaved] = useState(false);
  const [savingCredentials, setSavingCredentials] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  // Use a ref for lastLogIdx to avoid race conditions where the interval
  // fires before setLastLogIdx takes effect, causing duplicate log lines.
  const lastLogIdxRef = useRef(0);

  // Load stored Reddit credentials from the server on mount
  // so the user doesn't have to re-enter them every time.
  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        if (data?.config) {
          if (data.config.redditUsername) setRedditUsername(data.config.redditUsername);
          // The password comes back masked (e.g. "x•••x"). We set it as
          // the input value so the field shows dots. When the user clicks
          // Start, the run API will use the stored (unmasked) password
          // from .config.json since the masked value contains "•".
          if (data.config.redditPassword) {
            setRedditPassword(data.config.redditPassword);
            setCredentialsSaved(true);
          }
        }
      })
      .catch(() => {});
  }, []);

  // Save credentials to the server
  const saveCredentials = useCallback(async () => {
    setSavingCredentials(true);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redditUsername: redditUsername,
          redditPassword: redditPassword.includes("•") ? undefined : redditPassword,
        }),
      });
      setCredentialsSaved(true);
    } catch {} finally {
      setSavingCredentials(false);
    }
  }, [redditUsername, redditPassword]);

  // Poll run status
  useEffect(() => {
    let mounted = true;

    const poll = async () => {
      try {
        const res = await fetch(`/api/run?since=${lastLogIdxRef.current}`);
        if (!res.ok) return;
        const data: RunStatus = await res.json();
        if (!mounted) return;

        setRunStatus(data);

        // Append new log lines
        if (data.logs && data.logs.length > 0) {
          setLogLines((prev) => [...prev, ...data.logs]);
          lastLogIdxRef.current = data.totalLogLines;
          setLastLogIdx(data.totalLogLines);
        }

        // When the run completes or errors, refresh the CSV data
        // so the dashboard shows the latest statuses.
        if (
          (data.status === "completed" || data.status === "error") &&
          runStatus?.status === "running"
        ) {
          onCsvDataRefresh();
        }
      } catch {
        // ignore — will retry next poll
      }
    };

    // Refresh immediately when the tab becomes visible (mobile browsers
    // throttle timers in background tabs, so we kick the poll as soon as
    // the user comes back).
    const handleVisibility = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", handleVisibility);

    // Poll every 1 second when running, every 5 seconds when idle
    const interval = setInterval(
      () => {
        // Skip polling when the tab is hidden — the visibilitychange
        // listener above will catch us up when we return.
        if (document.visibilityState === "visible") poll();
      },
      runStatus?.status === "running" || runStatus?.status === "waiting-for-login"
        ? 1000
        : 5000
    );

    // Initial poll
    poll();

    return () => {
      mounted = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [lastLogIdx, runStatus?.status]);

  // Auto-scroll to bottom of log terminal
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logLines]);

  const handleStart = async () => {
    setStarting(true);
    setLogLines([]);
    setLastLogIdx(0);
    lastLogIdxRef.current = 0;
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start",
          csv: selectedCsv,
          headless: options.headless,
          verifyOnly: options.verifyOnly,
          reprocessFailed: options.reprocessFailed,
          maxSubscribes: options.maxSubscribes,
          redditUsername: redditUsername || undefined,
          redditPassword: redditPassword || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Failed to start");
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    setStopping(true);
    try {
      await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
    } finally {
      setStopping(false);
    }
  };

  const handleContinue = async () => {
    setContinuing(true);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "continue" }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Failed to continue");
      }
    } finally {
      setContinuing(false);
    }
  };

  const isRunning =
    runStatus?.status === "running" || runStatus?.status === "waiting-for-login";
  const isWaiting = runStatus?.status === "waiting-for-login";

  const statusConfig: Record<
    string,
    { label: string; color: string; bg: string; icon: typeof CheckCircle2 }
  > = {
    idle: {
      label: "Idle",
      color: "text-slate-500",
      bg: "bg-slate-100 dark:bg-slate-800",
      icon: Clock,
    },
    running: {
      label: "Running",
      color: "text-blue-600 dark:text-blue-400",
      bg: "bg-blue-50 dark:bg-blue-950/40",
      icon: Loader2,
    },
    "waiting-for-login": {
      label: "Waiting for Login",
      color: "text-amber-600 dark:text-amber-400",
      bg: "bg-amber-50 dark:bg-amber-950/40",
      icon: AlertCircle,
    },
    completed: {
      label: "Completed",
      color: "text-emerald-600 dark:text-emerald-400",
      bg: "bg-emerald-50 dark:bg-emerald-950/40",
      icon: CheckCircle2,
    },
    error: {
      label: "Error",
      color: "text-red-600 dark:text-red-400",
      bg: "bg-red-50 dark:bg-red-950/40",
      icon: XCircle,
    },
    stopped: {
      label: "Stopped",
      color: "text-slate-500",
      bg: "bg-slate-100 dark:bg-slate-800",
      icon: Ban,
    },
  };

  const currentStatus = runStatus?.status || "idle";
  const statusInfo = statusConfig[currentStatus];
  const StatusIcon = statusInfo.icon;

  return (
    <Card>
      <CardHeader className="border-b border-slate-200 dark:border-slate-800 py-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Terminal className="w-4 h-4" />
          Run Controls
          {/* Status badge */}
          <Badge
            variant="outline"
            className={cn("ml-2 gap-1.5 py-1.5 px-3", statusInfo.color, statusInfo.bg)}
          >
            <StatusIcon
              className={cn("w-3.5 h-3.5", currentStatus === "running" && "animate-spin")}
            />
            {statusInfo.label}
          </Badge>
          {runStatus?.pid && (
            <span className="text-xs text-slate-500 font-mono ml-1">
              PID: {runStatus.pid}
            </span>
          )}
          {/* Options toggle */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowOptions(!showOptions)}
            className="ml-auto"
          >
            <ChevronDown
              className={cn("w-4 h-4 transition-transform", showOptions && "rotate-180")}
            />
            Options
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        {/* Action buttons row */}
        <div className="flex flex-wrap gap-2 items-center">
          {/* Start button */}
          <Button
            onClick={handleStart}
            disabled={isRunning || starting || !selectedCsv}
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {starting ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Play className="w-4 h-4 mr-2" />
            )}
            Start
          </Button>

          {/* Reddit credentials — for auto-login */}
          <div className="flex items-center gap-2 ml-2">
            <Input
              type="text"
              placeholder="Reddit username"
              value={redditUsername}
              onChange={(e) => {
                setRedditUsername(e.target.value);
                setCredentialsSaved(false);
              }}
              className="w-36 h-8 text-xs"
              disabled={isRunning}
            />
            <div className="relative">
              <Input
                type={showPassword ? "text" : "password"}
                placeholder="Password"
                value={redditPassword}
                onChange={(e) => {
                  setRedditPassword(e.target.value);
                  setCredentialsSaved(false);
                }}
                className="w-32 h-8 text-xs pr-7"
                disabled={isRunning}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                tabIndex={-1}
              >
                {showPassword ? (
                  <EyeOff className="w-3.5 h-3.5" />
                ) : (
                  <Eye className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={saveCredentials}
              disabled={savingCredentials || isRunning || (!redditUsername && !redditPassword)}
              className="h-8 text-xs gap-1"
              title="Save credentials on the server so you don't have to re-enter them"
            >
              {savingCredentials ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : credentialsSaved ? (
                <CheckCircle2 className="w-3 h-3 text-emerald-500" />
              ) : null}
              {credentialsSaved ? "Saved" : "Save"}
            </Button>
            {redditUsername && redditPassword && (
              <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300">
                Auto-login
              </Badge>
            )}
          </div>

          {/* Continue button — only shown when waiting for login */}
          {isWaiting && (
            <Button
              onClick={handleContinue}
              disabled={continuing}
              className="bg-amber-500 hover:bg-amber-600 text-white animate-pulse"
            >
              {continuing ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <CheckCircle2 className="w-4 h-4 mr-2" />
              )}
              I&apos;m Logged In — Continue
            </Button>
          )}

          {/* Stop button */}
          <Button
            onClick={handleStop}
            disabled={!isRunning || stopping}
            variant="destructive"
          >
            {stopping ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Square className="w-4 h-4 mr-2" />
            )}
            Stop
          </Button>

          {/* Clear logs button */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLogLines([]);
              setLastLogIdx(0);
              lastLogIdxRef.current = 0;
            }}
          >
            Clear Logs
          </Button>

          {/* Run info */}
          {runStatus?.startedAt && (
            <span className="text-xs text-slate-500 ml-auto">
              Started: {formatTimestamp(runStatus.startedAt)}
              {runStatus.endedAt && (
                <> · Ended: {formatTimestamp(runStatus.endedAt)}</>
              )}
            </span>
          )}
        </div>

        {/* Waiting-for-login banner */}
        {isWaiting && (
          <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300 text-sm">
            <p className="font-semibold flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              Manual Login Required
            </p>
            <p className="text-xs mt-1">
              A browser window has opened. Log in to your Reddit burner account
              in that window. Once you see your Reddit homepage feed, click the
              <strong> &quot;I&apos;m Logged In — Continue&quot;</strong> button above.
            </p>
          </div>
        )}

        {/* Options panel */}
        {showOptions && (
          <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 space-y-2">
            <div className="flex flex-wrap gap-4">
              <div className="flex items-center gap-2">
                <Switch
                  checked={options.headless}
                  onCheckedChange={(v) => setOptions({ ...options, headless: v })}
                  id="opt-headless"
                />
                <Label htmlFor="opt-headless" className="text-xs cursor-pointer">
                  Headless (no browser window)
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={options.verifyOnly}
                  onCheckedChange={(v) =>
                    setOptions({ ...options, verifyOnly: v })
                  }
                  id="opt-verify"
                />
                <Label htmlFor="opt-verify" className="text-xs cursor-pointer">
                  Verify only
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={options.reprocessFailed}
                  onCheckedChange={(v) =>
                    setOptions({ ...options, reprocessFailed: v })
                  }
                  id="opt-reprocess"
                />
                <Label htmlFor="opt-reprocess" className="text-xs cursor-pointer">
                  Reprocess failed
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="opt-max" className="text-xs">
                  Max subscribes:
                </Label>
                <Input
                  type="number"
                  id="opt-max"
                  value={options.maxSubscribes}
                  onChange={(e) =>
                    setOptions({ ...options, maxSubscribes: parseInt(e.target.value) || 100 })
                  }
                  className="w-20 h-7 text-xs"
                />
              </div>
            </div>
            {runStatus?.scriptPath && (
              <p className="text-xs text-slate-500 font-mono">
                Script: {runStatus.scriptPath}
              </p>
            )}
            {runStatus?.pythonCmd && (
              <p className="text-xs text-slate-500 font-mono">
                Python: {runStatus.pythonCmd} on {runStatus.platform}
              </p>
            )}
          </div>
        )}

        {/* Live log terminal */}
        <div className="rounded-lg bg-slate-950 border border-slate-700 overflow-hidden">
          {/* Terminal header */}
          <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 border-b border-slate-700">
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
            </div>
            <span className="text-xs text-slate-400 font-mono ml-2">
              {logLines.length} lines
            </span>
            {isRunning && (
              <span className="text-xs text-green-400 font-mono ml-auto flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                LIVE
              </span>
            )}
          </div>
          {/* Terminal body */}
          <ScrollArea className="h-64 max-h-64">
            <div className="p-2 font-mono text-xs leading-relaxed">
              {logLines.length === 0 ? (
                <p className="text-slate-600 italic">
                  No logs yet. Click &quot;Start&quot; to begin.
                </p>
              ) : (
                logLines.map((line, i) => (
                  <div
                    key={i}
                    className={cn(
                      "whitespace-pre-wrap break-all",
                      line.stream === "stderr"
                        ? "text-amber-300"
                        : "text-slate-300"
                    )}
                  >
                    <span className="text-slate-600 select-none">
                      {new Date(line.timestamp).toLocaleTimeString(undefined, {
                        hour12: false,
                      })}{" "}
                    </span>
                    {line.text}
                  </div>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          </ScrollArea>
        </div>

        {/* Error display */}
        {runStatus?.error && (
          <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm">
            <p className="font-semibold">Run Error</p>
            <p className="text-xs mt-1 font-mono">{runStatus.error}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// StatCard sub-component
// ============================================================

function StatCard({
  title, value, total, icon: Icon, color, bg,
}: {
  title: string;
  value: number;
  total: number;
  icon: typeof CheckCircle2;
  color: string;
  bg: string;
}) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <Card className={cn("relative overflow-hidden bg-gradient-to-br", bg)}>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-medium text-slate-600 dark:text-slate-400">{title}</p>
            <p className="text-2xl font-bold text-slate-900 dark:text-slate-100 mt-1">
              {value}
              <span className="text-sm font-normal text-slate-500 ml-1">/ {total}</span>
            </p>
            <p className="text-xs text-slate-500 mt-0.5">{pct.toFixed(1)}%</p>
          </div>
          <div className={cn("p-2 rounded-lg bg-white/50 dark:bg-black/20", color)}>
            <Icon className="w-5 h-5" />
          </div>
        </div>
        {/* Mini progress bar */}
        <div className="mt-3 h-1 rounded-full bg-white/40 dark:bg-black/30 overflow-hidden">
          <motion.div
            className={cn("h-full rounded-full", color.replace("text-", "bg-"))}
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
