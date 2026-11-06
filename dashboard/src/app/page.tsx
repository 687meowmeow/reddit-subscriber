'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
// framer-motion (motion / AnimatePresence) intentionally NOT imported —
// the table rows and progress bars used to animate on every 3-second
// refresh, which caused the page to jump. Plain DOM elements render
// instantly and don't shift the layout.
import {
  CheckCircle2, XCircle, AlertCircle, Clock, Users, RefreshCw, Search,
  Loader2, FileText, Activity, Ban, Lock, ShieldAlert, Eye, EyeOff,
  ChevronDown, Filter, ExternalLink, Play, Square, Terminal, Settings,
  Github, Upload, Copy, Check, Download, Pencil, MoreVertical, Menu as MenuIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
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
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger, SheetClose,
} from "@/components/ui/sheet";
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
  followed: {
    label: "Followed", category: "done",
    color: "text-emerald-700 dark:text-emerald-300",
    bg: "bg-emerald-50 dark:bg-emerald-950/40",
    border: "border-emerald-200 dark:border-emerald-800",
    icon: CheckCircle2, description: "Successfully followed this user profile",
  },
  already_followed: {
    label: "Already Following", category: "done",
    color: "text-sky-700 dark:text-sky-300",
    bg: "bg-sky-50 dark:bg-sky-950/40",
    border: "border-sky-200 dark:border-sky-800",
    icon: CheckCircle2, description: "Was already following this user profile",
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
  const router = useRouter();
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
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
  const [typeFilter, setTypeFilter] = useState<"all" | "subreddit" | "account">("all");
  // Limit visible rows for performance — rendering 4035 rows at once
  // makes the page extremely laggy. Show 100, load more on demand.
  const [visibleCount, setVisibleCount] = useState<number>(100);
  // Debounced search — don't filter on every keystroke
  const [debouncedSearch, setDebouncedSearch] = useState<string>("");
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // NOTE: Find Similar state has moved to /find-similar (its own route).
  // The dashboard only needs the syncResult state below to show feedback
  // after the Sync button is clicked.

  // Sync subscriptions state
  const [syncing, setSyncing] = useState<boolean>(false);
  const [syncResult, setSyncResult] = useState<any>(null);

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

  // NOTE: the old Debug panel (Bug icon, environment diagnostics, CSV
  // list debug) has been REMOVED. It was a static snapshot of one
  // moment in time — useless for actually finding issues. It's been
  // replaced by the /logs page, which shows a live tail of EVERY
  // server-side action, request, response, and error. Click the
  // Terminal icon in the header (or use the "View Server Logs" item
  // in the mobile menu) to open it.

  // Fetch the list of CSV files
  const fetchCsvList = useCallback(async () => {
    setListError(null);
    try {
      const res = await fetch("/api/csv-list");
      const data = await res.json();
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
  // Uses a ref to skip re-rendering if nothing changed (prevents page jumping)
  const lastCsvDataRef = useRef<string>("");
  const fetchCsvData = useCallback(async (csv: string) => {
    if (!csv) return;
    // Don't set refreshing=true on auto-refresh — it causes the spinner
    // icon to flash and makes the page feel janky
    try {
      const res = await fetch(`/api/csv-data?csv=${encodeURIComponent(csv)}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        setCsvData(null);
      } else {
        // Only update state if the data actually changed.
        // This prevents the entire table (4000+ rows) from re-rendering
        // every 3 seconds when nothing has changed.
        const signature = `${data.totalRows}|${JSON.stringify(data.counts)}|${data.lastModified || ""}`;
        if (signature !== lastCsvDataRef.current) {
          lastCsvDataRef.current = signature;
          setCsvData(data);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
      setLastFetch(new Date());
    }
  }, []);

  // NOTE: fetchDebugInfo was removed when the Debug panel was replaced
  // by the /logs page. The /api/debug endpoint still exists for
  // backwards compat (and is itself logged now), but the dashboard
  // no longer calls it.

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
  // Find Similar now lives on its own page (/find-similar) —
  // the dashboard's "Find Similar" button just navigates there,
  // so we don't need the findSimilar callback here anymore.

  // Sync subscriptions — fetch live subscribed list from Reddit and add missing to CSV
  const syncSubscriptions = useCallback(async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/sync-subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: selectedCsv }),
      });
      const data = await res.json();
      setSyncResult(data);
      if (data.ok) {
        // Refresh the CSV data to show the new rows
        fetchCsvData(selectedCsv);
      }
    } catch (err) {
      setSyncResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setSyncing(false);
    }
  }, [selectedCsv, fetchCsvData]);

  // ============================================================
  // AUTO-SYNC — silent background sync.
  //
  // Every 24 HOURS when the dashboard is open AND a CSV is selected,
  // we silently call /api/sync-subscriptions in the background. If new
  // subs are detected (subs the user joined manually on Reddit that
  // aren't in the CSV yet), they get added as "pending" + a
  // first_seen_at timestamp. We show a small toast-style notification
  // banner so the user knows it happened.
  //
  // The auto-sync uses a SEPARATE state from the manual Sync button
  // so it doesn't trigger the spinner UI.
  //
  // NOTE: runAutoSync is stored in a ref so the interval effect below
  // doesn't get torn down and recreated when `syncing` changes (which
  // would reset the 24-hour timer every time the user clicks Sync).
  // ============================================================
  const [lastAutoSync, setLastAutoSync] = useState<Date | null>(null);
  const [autoSyncResult, setAutoSyncResult] = useState<{
    added: number;
    added_names: string[];
    timestamp: Date;
  } | null>(null);
  const autoSyncInProgressRef = useRef<boolean>(false);
  const runAutoSyncRef = useRef<() => void>(() => {});

  const runAutoSync = useCallback(async () => {
    if (!selectedCsv) return;
    if (syncing) return;
    if (autoSyncInProgressRef.current) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;

    autoSyncInProgressRef.current = true;
    try {
      const res = await fetch("/api/sync-subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: selectedCsv }),
      });
      const data = await res.json();
      setLastAutoSync(new Date());

      if (data.ok && data.added > 0) {
        setAutoSyncResult({
          added: data.added,
          added_names: data.added_names || [],
          timestamp: new Date(),
        });
        setTimeout(() => setAutoSyncResult(null), 60000);
        fetchCsvData(selectedCsv);
      }
    } catch (err) {
      console.warn("Auto-sync failed:", err);
    } finally {
      autoSyncInProgressRef.current = false;
    }
  }, [selectedCsv, syncing, fetchCsvData]);

  // Keep the ref updated with the latest version of runAutoSync.
  // The interval effect uses runAutoSyncRef.current() so it always
  // calls the latest function without needing to be recreated.
  useEffect(() => {
    runAutoSyncRef.current = runAutoSync;
  }, [runAutoSync]);

  // Run auto-sync every 24 hours. Only depends on selectedCsv so the
  // interval isn't torn down when syncing/runAutoSync changes.
  // The initial sync runs 60 seconds after dashboard load so the user
  // sees any new subs they joined while away.
  useEffect(() => {
    if (!selectedCsv) return;
    const initialTimer = setTimeout(() => {
      runAutoSyncRef.current();
    }, 60000);

    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        runAutoSyncRef.current();
      }
    }, 24 * 60 * 60 * 1000); // 24 hours

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        // Only auto-sync on tab focus if the last sync was > 1 hour ago.
        // This prevents spamming sync on rapid tab switches while still
        // catching new subs reasonably quickly.
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        if (!lastAutoSync || lastAutoSync.getTime() < oneHourAgo) {
          setTimeout(() => runAutoSyncRef.current(), 3000);
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [selectedCsv, lastAutoSync]);

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
    const done = (counts.subscribed || 0) + (counts.already_subscribed || 0) +
                 (counts.followed || 0) + (counts.already_followed || 0);
    const failed = (counts.failed || 0) + (counts.shadowbanned || 0) + (counts.aborted || 0);
    const pending = counts.pending || 0;
    const terminal =
      (counts.not_found || 0) + (counts.banned || 0) +
      (counts.private || 0) + (counts.quarantined || 0);
    return { total, done, failed, pending, terminal };
  }, [csvData]);

  // Debounce search input — wait 300ms after the user stops typing
  // before filtering. This prevents re-filtering 4035 rows on every
  // keystroke, which causes massive lag.
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(value);
      setVisibleCount(100); // reset pagination on new search
    }, 300);
  }, []);

  // Reset visible count when filters change
  useEffect(() => {
    setVisibleCount(100);
  }, [statusFilter, nsfwFilter, typeFilter]);

  // Filtered rows for the table
  const filteredRows = useMemo(() => {
    if (!csvData) return [];
    return csvData.rows.filter((row) => {
      const subCol = csvData.subCol || "subreddit";
      const name = (row[subCol] || "").toLowerCase();
      // search (uses debounced value)
      if (debouncedSearch && !name.includes(debouncedSearch.toLowerCase())) return false;
      // type filter (account vs subreddit)
      if (typeFilter !== "all") {
        const isAccount = name.startsWith("u_") || name.startsWith("u/");
        if (typeFilter === "account" && !isAccount) return false;
        if (typeFilter === "subreddit" && isAccount) return false;
      }
      // status filter — supports both category filters (done/failed/terminal)
      // and individual status filters (banned, private, not_found, etc.)
      if (statusFilter !== "all") {
        const status = (row.status || "pending").trim().toLowerCase() || "pending";
        // Category filters
        if (statusFilter === "done") {
          const category = STATUS_CONFIG[status]?.category || "pending";
          if (category !== "done") return false;
        } else if (statusFilter === "failed") {
          const category = STATUS_CONFIG[status]?.category || "pending";
          if (category !== "retryable") return false;
        } else if (statusFilter === "terminal") {
          const category = STATUS_CONFIG[status]?.category || "pending";
          if (category !== "terminal") return false;
        } else if (statusFilter === "pending") {
          if (status !== "pending") return false;
        } else {
          // Individual status filter (e.g. "banned", "private", "not_found")
          if (status !== statusFilter) return false;
        }
      }
      // NSFW filter
      if (nsfwFilter !== "all") {
        const nsfw = (row.is_nsfw || "").toLowerCase() === "true";
        if (nsfwFilter === "nsfw" && !nsfw) return false;
        if (nsfwFilter === "sfw" && nsfw) return false;
      }
      return true;
    });
  }, [csvData, debouncedSearch, statusFilter, nsfwFilter, typeFilter]);

  // Only render the first `visibleCount` rows — this is the key to
  // eliminating UI lag. Rendering 4035 <tr> elements every refresh
  // was the bottleneck. Now we only render 100 at a time.
  const visibleRows = useMemo(() => filteredRows.slice(0, visibleCount), [filteredRows, visibleCount]);

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-slate-50 via-white to-slate-100 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
      {/* Header — compact on mobile, full on desktop.
          The top row is logo + title + Menu button (mobile only).
          The CSV selector and primary actions live on a second row
          that wraps naturally. Less-used actions (Import CSV, Sync,
          Find Similar, Settings, Debug) collapse into a Sheet on
          small screens so they don't bloat the header. */}
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-3 sm:px-4 py-2.5 sm:py-3 flex items-center gap-2 sm:gap-3">
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg sm:rounded-xl bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center text-white shadow-md">
              <Activity className="w-4 h-4 sm:w-5 sm:h-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm sm:text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100 truncate">
                <span className="sm:hidden">Reddit Subs</span>
                <span className="hidden sm:inline">Reddit Subscriber Dashboard</span>
              </h1>
              <p className="text-[10px] sm:text-xs text-slate-500 dark:text-slate-400 hidden sm:block">
                Live status monitor for the browser subscriber script
              </p>
            </div>
          </div>

          {/* Right side actions. On mobile, only the manual refresh and
              the "More" menu are visible. On desktop, all actions are
              visible in a row. */}
          <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
            {/* CSV selector — visible on desktop only (mobile uses the
                filters row below). Hiding it on mobile keeps the header
                to a single row. */}
            <Select value={selectedCsv} onValueChange={setSelectedCsv}>
              <SelectTrigger className="w-[280px] hidden sm:flex">
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

            {/* Auto-refresh toggle — desktop only on this row */}
            <div className="hidden sm:flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <Switch
                checked={autoRefresh}
                onCheckedChange={setAutoRefresh}
                id="auto-refresh"
              />
              <Label htmlFor="auto-refresh" className="text-xs cursor-pointer">
                Auto-refresh
              </Label>
              {autoRefresh && (
                <span className="text-[10px] text-slate-500 ml-1">3s</span>
              )}
            </div>

            {/* Manual refresh — always visible (primary action) */}
            <Button
              variant="outline"
              size="icon"
              onClick={() => {
                setRefreshing(true);
                fetchCsvData(selectedCsv);
              }}
              disabled={refreshing}
              title="Refresh now"
            >
              <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
            </Button>

            {/* Settings — always visible (primary action).
                A small green dot shows when auto-update is active. */}
            <Button
              variant="outline"
              size="icon"
              onClick={() => {
                setShowSettings(!showSettings);
                if (!showSettings) fetchSettings();
              }}
              title="Settings — set CSV directory, Python path, and GitHub auto-update"
              className={cn("relative", showSettings && "bg-blue-100 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700")}
            >
              <Settings className="w-4 h-4" />
              {settings.autoUpdate && settings.githubRepo && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-500 border border-white dark:border-slate-900 animate-pulse" />
              )}
            </Button>

            {/* "More" menu (mobile only) — opens a Sheet containing
                Import CSV, Sync, Find Similar, Debug, Auto-refresh
                toggle, and the CSV selector. On desktop these are
                visible directly in the header so the Sheet is hidden. */}
            <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="sm:hidden relative"
                  title="More actions"
                >
                  <MoreVertical className="w-4 h-4" />
                  {syncing && (
                    <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-500 border border-white dark:border-slate-900 animate-pulse" />
                  )}
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-[85vw] sm:w-96 overflow-y-auto">
                <SheetHeader>
                  <SheetTitle>Actions</SheetTitle>
                </SheetHeader>
                <div className="px-4 pb-6 space-y-3">
                  {/* CSV selector on mobile */}
                  <div className="space-y-1.5">
                    <Label className="text-xs font-medium">CSV File</Label>
                    <Select
                      value={selectedCsv}
                      onValueChange={(v) => { setSelectedCsv(v); setMobileMenuOpen(false); }}
                    >
                      <SelectTrigger className="w-full">
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
                              <span className="font-medium truncate">{f.name}</span>
                              <span className="ml-2 text-xs text-slate-500">
                                {(f.size / 1024).toFixed(1)}KB
                              </span>
                              {f.isStatusFile && (
                                <Badge variant="outline" className="ml-2 py-0 px-1.5 text-[10px] border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300">
                                  STATUS
                                </Badge>
                              )}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Auto-refresh toggle on mobile */}
                  <div className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                    <Label htmlFor="auto-refresh-mobile" className="text-xs cursor-pointer flex items-center gap-2">
                      <RefreshCw className="w-3.5 h-3.5" />
                      Auto-refresh (3s)
                    </Label>
                    <Switch
                      checked={autoRefresh}
                      onCheckedChange={setAutoRefresh}
                      id="auto-refresh-mobile"
                    />
                  </div>

                  {/* Hidden file input — there's only ONE shared file input
                      that lives in the desktop section below. Both the
                      desktop Import CSV button and the mobile Sheet's
                      Import CSV button trigger the same input via
                      fileInputRef. We deliberately do NOT declare a
                      second input here — two inputs with the same ref
                      would cause one of them to be inaccessible. */}

                  {/* Import CSV */}
                  <Button
                    variant="outline"
                    className="w-full justify-start gap-2"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                  >
                    {uploading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Upload className="w-4 h-4" />
                    )}
                    Import CSV
                    {uploading && <span className="text-xs text-slate-500">uploading…</span>}
                  </Button>

                  {/* Sync Subscriptions */}
                  <Button
                    variant="outline"
                    className="w-full justify-start gap-2"
                    onClick={() => { syncSubscriptions(); setMobileMenuOpen(false); }}
                    disabled={syncing}
                  >
                    {syncing ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <RefreshCw className="w-4 h-4" />
                    )}
                    Sync Subscriptions
                  </Button>

                  {/* Find Similar — opens a separate page */}
                  <Button
                    variant="outline"
                    className="w-full justify-start gap-2"
                    onClick={() => {
                      setMobileMenuOpen(false);
                      router.push(`/find-similar${selectedCsv ? `?csv=${encodeURIComponent(selectedCsv)}` : ""}`);
                    }}
                  >
                    <Search className="w-4 h-4" />
                    Find Similar Subreddits
                  </Button>

                  {/* View Logs — navigates to the standalone /logs page */}
                  <Button
                    variant="outline"
                    className="w-full justify-start gap-2"
                    onClick={() => {
                      setMobileMenuOpen(false);
                      router.push("/logs");
                    }}
                  >
                    <Terminal className="w-4 h-4" />
                    View Server Logs
                  </Button>

                  <SheetClose asChild>
                    <Button variant="ghost" className="w-full">
                      Close
                    </Button>
                  </SheetClose>
                </div>
              </SheetContent>
            </Sheet>

            {/* Desktop-only buttons (hidden on mobile, where they
                live inside the Sheet menu above). */}
            {/* Single shared hidden file input — used by both the
                desktop Import CSV button and the mobile Sheet's
                Import CSV button. */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.status.csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFileUpload(file);
                e.target.value = "";
                setMobileMenuOpen(false);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              title="Upload a CSV file from this device to the Pi"
              className="gap-1.5 hidden sm:flex"
            >
              {uploading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              <span>Import CSV</span>
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={syncSubscriptions}
              disabled={syncing}
              title="Fetch your live subscribed subreddits from Reddit and add any missing ones to the CSV"
              className="gap-1.5 hidden sm:flex"
            >
              {syncing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              <span>Sync</span>
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                router.push(`/find-similar${selectedCsv ? `?csv=${encodeURIComponent(selectedCsv)}` : ""}`);
              }}
              title="Find similar subreddits to banned ones"
              className="gap-1.5 hidden sm:flex"
            >
              <Search className="w-4 h-4" />
              <span>Find Similar</span>
            </Button>

            <Button
              variant="outline"
              size="icon"
              onClick={() => router.push("/logs")}
              title="View server logs (every action, request, and error)"
              className="hidden sm:flex"
            >
              <Terminal className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Last fetch indicator — hidden on mobile to save vertical space */}
        <div className="container mx-auto px-4 pb-2 hidden sm:flex items-center gap-2 text-xs text-slate-500">
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
      <main className="container mx-auto px-3 sm:px-4 py-4 sm:py-6 flex-1 flex flex-col gap-4 sm:gap-6">
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

        {/* Auto-sync notification banner — shows when the background
            sync detects new subreddits the user joined on Reddit. */}
        {autoSyncResult && (
          <Card className="border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/30">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-emerald-700 dark:text-emerald-300">
                    Auto-detected {autoSyncResult.added} new subreddit{autoSyncResult.added === 1 ? "" : "s"} you joined on Reddit
                  </p>
                  <p className="text-xs text-emerald-700 dark:text-emerald-400 mt-1 break-words">
                    Added as <strong>pending</strong>: {autoSyncResult.added_names.join(", ")}
                    {autoSyncResult.added_names.length < autoSyncResult.added && ` ...and ${autoSyncResult.added - autoSyncResult.added_names.length} more`}
                  </p>
                  <p className="text-[10px] text-slate-500 mt-1">
                    Detected at {autoSyncResult.timestamp.toLocaleTimeString(undefined, { hour12: false })}
                    {" · "}Next auto-sync in 24 hours
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setAutoSyncResult(null)}
                  className="text-emerald-700 dark:text-emerald-400"
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
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
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
        <div className="flex flex-wrap gap-2 sm:gap-3 items-center" suppressHydrationWarning>
          <div className="relative flex-1 min-w-[160px] sm:min-w-[240px] max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <Input
              placeholder="Search subreddits..."
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="pl-10"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[130px] sm:w-[160px]">
              <Filter className="w-4 h-4 mr-2 text-slate-500" />
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="done">✓ Subscribed (all)</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="terminal">✗ Terminal (all)</SelectItem>
              <SelectItem value="subscribed">— Subscribed</SelectItem>
              <SelectItem value="already_subscribed">— Already Subscribed</SelectItem>
              <SelectItem value="followed">— Followed</SelectItem>
              <SelectItem value="already_followed">— Already Following</SelectItem>
              <SelectItem value="banned">— Banned</SelectItem>
              <SelectItem value="private">— Private</SelectItem>
              <SelectItem value="quarantined">— Quarantined</SelectItem>
              <SelectItem value="not_found">— Not Found</SelectItem>
              <SelectItem value="shadowbanned">— Shadowbanned</SelectItem>
              <SelectItem value="aborted">— Aborted</SelectItem>
            </SelectContent>
          </Select>
          {/* Type filter: subreddit vs user account */}
          <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as "all" | "subreddit" | "account")}>
            <SelectTrigger className="w-[110px] sm:w-[130px]">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="subreddit">Subreddits</SelectItem>
              <SelectItem value="account">Accounts</SelectItem>
            </SelectContent>
          </Select>
          <Select value={nsfwFilter} onValueChange={(v) => setNsfwFilter(v as typeof nsfwFilter)}>
            <SelectTrigger className="w-[120px] sm:w-[140px]">
              <SelectValue placeholder="All content" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All content</SelectItem>
              <SelectItem value="sfw">SFW only</SelectItem>
              <SelectItem value="nsfw">NSFW only</SelectItem>
            </SelectContent>
          </Select>
          <div className="text-xs text-slate-500 ml-auto hidden sm:block">
            Showing {visibleRows.length} of {filteredRows.length}
          </div>
          {/* Export banned CSV */}
          {csvData && csvData.counts?.banned > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                // Export only banned rows as a CSV file.
                // Subreddit names technically can't contain commas/quotes,
                // but we escape defensively anyway so the export round-trips
                // cleanly through any CSV reader (Excel, Numbers, etc.).
                const subCol = csvData.subCol || "subreddit";
                const bannedRows = csvData.rows.filter(
                  (r) => (r.status || "").trim().toLowerCase() === "banned"
                );
                if (bannedRows.length === 0) return;
                // Proper CSV escaping: wrap in quotes if the field contains
                // a comma, double-quote, or newline; double any embedded quotes.
                const escapeCsv = (v: string) => {
                  if (!v) return "";
                  if (v.includes(",") || v.includes('"') || v.includes("\n")) {
                    return `"${v.replace(/"/g, '""')}"`;
                  }
                  return v;
                };
                const lines = [`${escapeCsv(subCol)},status`];
                for (const row of bannedRows) {
                  const name = row[subCol] || "";
                  lines.push(`${escapeCsv(name)},banned`);
                }
                const csv = lines.join("\n");
                const blob = new Blob([csv], { type: "text/csv" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "banned_subreddits.csv";
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="gap-1.5"
              title="Download a CSV of all banned subreddits"
            >
              <Download className="w-3.5 h-3.5" />
              Export Banned ({csvData.counts.banned})
            </Button>
          )}
        </div>

        {/* Sync result banner — moved out of the (now removed) inline
            Find Similar panel. Shows the result of the Sync Subscriptions
            button so the user gets feedback after clicking it. */}
        {syncResult && (
          <Card className={cn(
            "border",
            syncResult.error
              ? "border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-950/20"
              : "border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20"
          )}>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-start gap-3">
                {syncResult.error ? (
                  <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                ) : (
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 flex-shrink-0 mt-0.5" />
                )}
                <div className="flex-1 min-w-0">
                  {syncResult.error ? (
                    <>
                      <p className="font-semibold text-red-700 dark:text-red-300">Sync failed</p>
                      <p className="text-sm text-red-600 dark:text-red-400 mt-1 break-words">
                        {syncResult.error}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="font-semibold text-emerald-700 dark:text-emerald-300">
                        Sync complete
                      </p>
                      <p className="text-sm text-emerald-700 dark:text-emerald-400 mt-1">
                        {syncResult.message}
                      </p>
                      {syncResult.total_live > 0 && (
                        <p className="text-xs text-slate-500 mt-1">
                          Live subscriptions on Reddit: {syncResult.total_live}
                        </p>
                      )}
                      {syncResult.added_names && syncResult.added_names.length > 0 && (
                        <p className="text-xs text-slate-500 mt-1">
                          Added: {syncResult.added_names.join(", ")}
                          {syncResult.added > 10 && ` ...and ${syncResult.added - 10} more`}
                        </p>
                      )}
                      {syncResult.warning && (
                        <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                          ⚠ {syncResult.warning}
                        </p>
                      )}
                    </>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSyncResult(null)}
                  className="text-slate-500"
                >
                  Dismiss
                </Button>
              </div>
            </CardContent>
          </Card>
        )}


        {/* Subreddit table */}
        <Card className="flex-1 flex flex-col min-h-[400px]">
          <CardHeader className="border-b border-slate-200 dark:border-slate-800 py-3">
            <CardTitle className="text-base flex items-center justify-between">
              <span>Subreddits</span>
              <span className="text-xs text-slate-500 font-normal">
                Showing {visibleRows.length} of {filteredRows.length}
                {filteredRows.length !== (csvData?.totalRows ?? 0) && (
                  <span className="ml-1">(filtered from {csvData?.totalRows ?? 0})</span>
                )}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 flex-1 flex flex-col overflow-hidden">
            {/* Native scroll container — works on all devices (touch + mouse) */}
            {/* overflow-auto gives both vertical AND horizontal scroll on mobile */}
            <div
              className="flex-1 overflow-auto"
              style={{
                maxHeight: "60vh",
                WebkitOverflowScrolling: "touch",
              }}
            >
              {/* min-w-full ensures the table is at least full width but can
                  grow wider for horizontal scroll on small screens */}
              <div className="min-w-full inline-block">
                <table className="w-full text-sm border-collapse whitespace-nowrap">
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
                    {/* Plain <tr> elements — NO motion animations.
                        motion.tr + AnimatePresence caused the page to jump
                        every 3 seconds when csvData refreshed because each
                        row re-animated. Plain rows render instantly and
                        don't shift the layout. */}
                    {filteredRows.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="text-center py-12 text-slate-500">
                            {csvData ? "No rows match the current filters." : "No CSV loaded."}
                          </td>
                        </tr>
                      ) : (
                        visibleRows.map((row, idx) => {
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
                          // "New" badge — show for subs added to the CSV in the
                          // last 24 hours (via auto-sync or manual add). Uses
                          // the first_seen_at column that sync-subscriptions
                          // writes. If the column doesn't exist, no badge.
                          const firstSeenAt = row.first_seen_at || "";
                          let isNew = false;
                          if (firstSeenAt) {
                            try {
                              const seen = new Date(firstSeenAt).getTime();
                              const ageMs = Date.now() - seen;
                              isNew = ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000; // < 24h
                            } catch {}
                          }

                          return (
                            <tr
                              key={`${name}-${idx}`}
                              className={cn(
                                "border-b border-slate-100 dark:border-slate-900 hover:bg-slate-50 dark:hover:bg-slate-900/50 group",
                                isNew && "bg-blue-50/40 dark:bg-blue-950/20"
                              )}
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
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      {nsfw && (
                                        <Badge variant="outline" className="text-[10px] py-0 px-1.5 w-fit border-rose-300 text-rose-700 dark:border-rose-700 dark:text-rose-300">
                                          NSFW
                                        </Badge>
                                      )}
                                      {isNew && (
                                        <Badge variant="outline" className="text-[10px] py-0 px-1.5 w-fit border-blue-400 text-blue-700 dark:border-blue-600 dark:text-blue-300 bg-blue-100 dark:bg-blue-950/40 animate-pulse">
                                          NEW
                                        </Badge>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </td>

                              {/* Status (with edit dropdown) */}
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-1.5">
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
                                  {/* Edit status dropdown */}
                                  <Select
                                    value=""
                                    onValueChange={(newStatus) => {
                                      // Optimistic update — immediately change the row's status in the UI
                                      const subCol = csvData?.subCol || "subreddit";
                                      setCsvData((prev) => prev ? {
                                        ...prev,
                                        rows: prev.rows.map((r) =>
                                          r[subCol] === name ? { ...r, status: newStatus } : r
                                        ),
                                      } : prev);
                                      // Send to server
                                      fetch("/api/csv-update-row", {
                                        method: "POST",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({
                                          csv: selectedCsv,
                                          subreddit: name,
                                          status: newStatus,
                                        }),
                                      }).catch(() => {
                                        // On error, refresh to get the real state
                                        fetchCsvData(selectedCsv);
                                      });
                                    }}
                                  >
                                    <SelectTrigger className="w-7 h-6 p-0 border-0 bg-transparent hover:bg-slate-200 dark:hover:bg-slate-800">
                                      <Pencil className="w-3 h-3 text-slate-400 group-hover:text-slate-600 dark:group-hover:text-slate-300" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="pending">Pending</SelectItem>
                                      <SelectItem value="subscribed">Subscribed</SelectItem>
                                      <SelectItem value="already_subscribed">Already Subscribed</SelectItem>
                                      <SelectItem value="followed">Followed</SelectItem>
                                      <SelectItem value="already_followed">Already Following</SelectItem>
                                      <SelectItem value="failed">Failed</SelectItem>
                                      <SelectItem value="banned">Banned</SelectItem>
                                      <SelectItem value="private">Private</SelectItem>
                                      <SelectItem value="quarantined">Quarantined</SelectItem>
                                      <SelectItem value="not_found">Not Found</SelectItem>
                                    </SelectContent>
                                  </Select>
                                  {/* Find Similar button — only for banned/not_found rows.
                                      Navigates to the standalone /find-similar page
                                      pre-filled with this subreddit's name. */}
                                  {(status === "banned" || status === "not_found") && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 w-7 p-0 hover:bg-blue-100 dark:hover:bg-blue-900/30"
                                      onClick={() => {
                                        router.push(
                                          `/find-similar?sub=${encodeURIComponent(name)}${
                                            selectedCsv ? `&csv=${encodeURIComponent(selectedCsv)}` : ""
                                          }`
                                        );
                                      }}
                                      title="Find similar unbanned subreddits"
                                    >
                                      <Search className="w-3 h-3 text-blue-500 group-hover:text-blue-600 dark:group-hover:text-blue-400" />
                                    </Button>
                                  )}
                                </div>
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
                            </tr>
                          );
                        })
                      )}
                  </tbody>
                </table>
              </div>
              {/* Load more button — only show if there are more rows */}
              {visibleCount < filteredRows.length && (
                <div className="p-3 border-t border-slate-200 dark:border-slate-800 text-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setVisibleCount((c) => c + 100)}
                    className="w-full"
                  >
                    Load more ({filteredRows.length - visibleCount} remaining)
                  </Button>
                </div>
              )}
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
            {lastAutoSync && (
              <>
                <span>·</span>
                <span title="Background sync runs every 24 hours to auto-detect subs you joined on Reddit">
                  Auto-sync: {formatRelativeTime(lastAutoSync.toISOString())}
                </span>
              </>
            )}
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
  // MAX_LOG_LINES_CLIENT — cap the number of log lines we render in the
  // terminal. Without this, a long-running subscriber pass would push
  // thousands of lines into React state, and the terminal would get
  // noticeably laggy (each refresh re-renders ALL the lines).
  // 1000 lines is ~50KB of text — enough context to scroll back through
  // recent activity without slowing down the UI.
  const MAX_LOG_LINES_CLIENT = 1000;
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [logsCopied, setLogsCopied] = useState(false);
  const [options, setOptions] = useState<{
    headless: boolean;
    verifyOnly: boolean;
    reprocessFailed: boolean;
    maxSubscribes: number | "";
    speedMode: "normal" | "fast" | "turbo";
  }>({
    headless: false,
    verifyOnly: false,
    reprocessFailed: false,
    maxSubscribes: 100,
    speedMode: "normal",
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

        // Append new log lines (capped at MAX_LOG_LINES_CLIENT to keep
        // the UI responsive on long runs — otherwise rendering thousands
        // of <div>s every poll cycle makes the terminal janky).
        if (data.logs && data.logs.length > 0) {
          setLogLines((prev) => {
            const combined = [...prev, ...data.logs];
            if (combined.length > MAX_LOG_LINES_CLIENT) {
              return combined.slice(-MAX_LOG_LINES_CLIENT);
            }
            return combined;
          });
          lastLogIdxRef.current = data.totalLogLines;
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
    // NOTE: this effect intentionally does NOT depend on lastLogIdx.
    // lastLogIdx is stored in a ref (lastLogIdxRef.current) so the
    // polling function always reads the latest value without needing
    // the effect to be torn down and recreated on every poll cycle.
    // Including lastLogIdx in the deps array (as before) caused the
    // effect to be recreated every time logs arrived, which cleared
    // and recreated the interval constantly — wasteful and a source
    // of subtle timing bugs. We only want to recreate the effect when
    // the polling cadence needs to change (running vs idle).
  }, [runStatus?.status, onCsvDataRefresh]);

  // Auto-scroll to bottom of log terminal
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logLines]);

  const handleStart = async () => {
    setStarting(true);
    // Optimistic update — immediately show "running" state so the UI
    // feels responsive without waiting for the API response
    setRunStatus((prev) => prev ? { ...prev, status: "running" } : {
      status: "running", pid: null, startedAt: new Date().toISOString(),
      endedAt: null, csv: selectedCsv, error: null, logs: [],
      totalLogLines: 0, scriptPath: "", csvRoot: "", pythonCmd: "", platform: "",
    });
    setLogLines([]);
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
          maxSubscribes: typeof options.maxSubscribes === "number" && options.maxSubscribes > 0
            ? options.maxSubscribes
            : 100,
          speedMode: options.speedMode,
          redditUsername: redditUsername || undefined,
          redditPassword: redditPassword || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Revert optimistic update on error
        setRunStatus((prev) => prev ? { ...prev, status: "error", error: data.error } : prev);
        alert(data.error || "Failed to start");
      }
    } catch (err) {
      setRunStatus((prev) => prev ? { ...prev, status: "error" } : prev);
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    setStopping(true);
    // Optimistic update — immediately show "stopped" state
    setRunStatus((prev) => prev ? { ...prev, status: "stopped" } : prev);
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
    // Optimistic update — immediately show "running" state
    setRunStatus((prev) => prev ? { ...prev, status: "running" } : prev);
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

  // Copy all log lines to clipboard
  const handleCopyLogs = async () => {
    const text = logLines
      .map((line) =>
        `[${new Date(line.timestamp).toLocaleTimeString(undefined, { hour12: false })}] ${line.text}`
      )
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setLogsCopied(true);
      setTimeout(() => setLogsCopied(false), 2000);
    } catch {
      // Fallback for older browsers / non-secure contexts
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand("copy");
        setLogsCopied(true);
        setTimeout(() => setLogsCopied(false), 2000);
      } catch {}
      document.body.removeChild(textarea);
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
          {/* Wraps to its own row on mobile, inline on desktop */}
          <div className="flex flex-wrap items-center gap-2 ml-0 sm:ml-2 w-full sm:w-auto">
            <Input
              type="text"
              placeholder="Reddit username"
              value={redditUsername}
              onChange={(e) => {
                setRedditUsername(e.target.value);
                setCredentialsSaved(false);
              }}
              className="w-full sm:w-36 h-8 text-xs"
              disabled={isRunning}
            />
            <div className="relative flex-1 sm:flex-none">
              <Input
                type={showPassword ? "text" : "password"}
                placeholder="Password"
                value={redditPassword}
                onChange={(e) => {
                  setRedditPassword(e.target.value);
                  setCredentialsSaved(false);
                }}
                className="w-full sm:w-32 h-8 text-xs pr-7"
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

          {/* Copy logs button */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopyLogs}
            disabled={logLines.length === 0}
            className="gap-1.5"
            title="Copy all log lines to clipboard"
          >
            {logsCopied ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-500" />
                Copied!
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                Copy Logs
              </>
            )}
          </Button>

          {/* Clear logs button */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLogLines([]);
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
                  onChange={(e) => {
                    // Allow empty string while typing (don't force 100)
                    const raw = e.target.value;
                    if (raw === "") {
                      setOptions({ ...options, maxSubscribes: "" });
                    } else {
                      const parsed = parseInt(raw);
                      // Only update if it's a valid number — don't fall back to 100
                      if (!isNaN(parsed) && parsed >= 0) {
                        setOptions({ ...options, maxSubscribes: parsed });
                      }
                    }
                  }}
                  onBlur={() => {
                    // When the field loses focus, ensure we have a valid number
                    const val = options.maxSubscribes;
                    if (val === "" || val === undefined || (typeof val === "number" && val < 1)) {
                      setOptions({ ...options, maxSubscribes: 100 });
                    }
                  }}
                  min={1}
                  className="w-20 h-7 text-xs"
                />
              </div>
            </div>

            {/* Speed mode selector */}
            <div className="flex items-center gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
              <Label className="text-xs font-medium">Speed:</Label>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant={options.speedMode === "normal" ? "default" : "outline"}
                  onClick={() => setOptions({ ...options, speedMode: "normal" })}
                  className="h-7 text-xs"
                  title="Normal speed — safe, ~50s per row, lowest shadowban risk"
                >
                  Normal
                </Button>
                <Button
                  size="sm"
                  variant={options.speedMode === "fast" ? "default" : "outline"}
                  onClick={() => setOptions({ ...options, speedMode: "fast" })}
                  className={cn("h-7 text-xs", options.speedMode === "fast" && "bg-amber-600 hover:bg-amber-700 text-white")}
                  title="Fast mode — ~20s per row, higher shadowban risk"
                >
                  Fast
                </Button>
                <Button
                  size="sm"
                  variant={options.speedMode === "turbo" ? "default" : "outline"}
                  onClick={() => setOptions({ ...options, speedMode: "turbo" })}
                  className={cn("h-7 text-xs", options.speedMode === "turbo" && "bg-red-600 hover:bg-red-700 text-white")}
                  title="Turbo mode — ~10s per row, VERY high shadowban risk. Use only on throwaway accounts."
                >
                  Turbo
                </Button>
              </div>
              {options.speedMode === "fast" && (
                <span className="text-[10px] text-amber-600 dark:text-amber-400 ml-2">
                  ~3x faster, higher shadowban risk
                </span>
              )}
              {options.speedMode === "turbo" && (
                <span className="text-[10px] text-red-600 dark:text-red-400 ml-2">
                  ~5x faster, VERY high shadowban risk — burner only!
                </span>
              )}
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
                logLines.map((line, i) => {
                  // Determine log level from the text content, not the stream.
                  // Python's logging module sends both INFO and WARNING to stderr,
                  // so we can't rely on the stream to determine the color.
                  const text = line.text;
                  const isWarning = text.includes("[WARNING]") || text.includes("[WARN]");
                  const isError = text.includes("[ERROR]") || text.includes("[CRITICAL]");
                  const isHealth = text.includes("[health]");
                  const colorClass = isError
                    ? "text-red-400"
                    : isWarning
                    ? "text-amber-300"
                    : isHealth
                    ? "text-cyan-300"
                    : "text-slate-300";
                  return (
                  <div
                    key={i}
                    className={cn(
                      "whitespace-pre-wrap break-all",
                      colorClass
                    )}
                  >
                    <span className="text-slate-600 select-none">
                      {new Date(line.timestamp).toLocaleTimeString(undefined, {
                        hour12: false,
                      })}{" "}
                    </span>
                    {text}
                  </div>
                  );
                })
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
      <CardContent className="pt-4 sm:pt-6">
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <p className="text-xs sm:text-sm font-medium text-slate-600 dark:text-slate-400 truncate">{title}</p>
            <p className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-slate-100 mt-1">
              {value}
              <span className="text-xs sm:text-sm font-normal text-slate-500 ml-1">/ {total}</span>
            </p>
            <p className="text-[10px] sm:text-xs text-slate-500 mt-0.5">{pct.toFixed(1)}%</p>
          </div>
          <div className={cn("p-1.5 sm:p-2 rounded-lg bg-white/50 dark:bg-black/20 flex-shrink-0", color)}>
            <Icon className="w-4 h-4 sm:w-5 sm:h-5" />
          </div>
        </div>
        {/* Mini progress bar — plain CSS transition (no motion) to avoid
            layout shifts on refresh */}
        <div className="mt-3 h-1 rounded-full bg-white/40 dark:bg-black/30 overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-all duration-300", color.replace("text-", "bg-"))}
            style={{ width: `${pct}%` }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
