'use client'

import { useState, useCallback, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Search, Loader2, ArrowLeft, ExternalLink, Users, AlertCircle,
  CheckCircle2, RefreshCw, Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// ============================================================
// Standalone /find-similar page.
//
// Why a separate page:
//   - The Find Similar feature has its own search input, filter
//     controls, and a long list of results. Putting all that inline
//     in the dashboard pushed the table down and made the page
//     feel cramped — especially on mobile.
//   - As a separate route, it gets the full viewport, can be
//     bookmarked, and the user can use the browser Back button to
//     return to the dashboard.
//
// URL params:
//   ?sub=NAME   pre-fill the search with a subreddit name (used
//               by the dashboard's "Find Similar" button on
//               banned/not_found rows, and by the header button
//               when no subreddit is preselected)
//   ?csv=NAME   pre-select the CSV to check "already_in_csv" against
// ============================================================

function formatNumber(n: string | number | undefined): string {
  if (!n && n !== 0) return "—";
  const num = typeof n === "number" ? n : parseInt(String(n), 10);
  if (isNaN(num)) return String(n);
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + "M";
  if (num >= 1_000) return (num / 1_000).toFixed(1) + "K";
  return num.toString();
}

interface DiagnosticEntry {
  step: string;
  url: string;
  status: number;
  content_type?: string;
  body_snippet: string;
  is_json: boolean;
  duration_ms: number;
}

interface SimilarSubreddit {
  name: string;
  display_name: string;
  subscribers: number;
  description: string;
  is_nsfw: boolean;
  relevance_score: number;
  already_in_csv: boolean;
  url: string;
}

function FindSimilarContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Pre-fill from URL params (?sub=NAME&csv=NAME)
  const initialSub = searchParams.get("sub") || "";
  const initialCsv = searchParams.get("csv") || "";

  const [input, setInput] = useState<string>(initialSub);
  const [searchedFor, setSearchedFor] = useState<string>(initialSub);
  const [loading, setLoading] = useState<boolean>(false);
  const [results, setResults] = useState<SimilarSubreddit[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [csvName, setCsvName] = useState<string>(initialCsv);
  const [diagnostics, setDiagnostics] = useState<DiagnosticEntry[]>([]);

  // Sort / filter state
  const [sortBy, setSortBy] = useState<"relevance" | "subscribers">("relevance");
  const [nsfwFilter, setNsfwFilter] = useState<"all" | "sfw" | "nsfw">("all");
  const [minSubs, setMinSubs] = useState<number>(0);

  // Detect "u_" prefix to give a clearer error
  const isUserProfile = (name: string) =>
    name.toLowerCase().startsWith("u_") || name.toLowerCase().startsWith("u/");

  const doSearch = useCallback(async (subredditName: string) => {
    const trimmed = subredditName.trim().replace(/^r\//i, "").replace(/^\/r\//i, "");
    if (!trimmed) return;

    // Don't try to find similar for user profiles — the find-similar
    // endpoint searches /subreddits/search.json which is subreddit-only.
    if (isUserProfile(trimmed)) {
      setError(
        `"${trimmed}" looks like a user profile (u_ prefix). Find Similar only works for subreddits, not user accounts.`
      );
      setResults([]);
      setKeywords([]);
      setSearchedFor(trimmed);
      return;
    }

    setLoading(true);
    setError(null);
    setResults([]);
    setKeywords([]);
    setDiagnostics([]);
    setSearchedFor(trimmed);
    try {
      const res = await fetch("/api/find-similar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subreddit: trimmed, csv: csvName || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `HTTP ${res.status}`);
        // Even on error, the API may include diagnostics showing
        // what Reddit returned (helpful for debugging auth issues).
        if (data.diagnostics) setDiagnostics(data.diagnostics);
      } else {
        setResults(data.results || []);
        setKeywords(data.keywords || []);
        if (data.diagnostics) setDiagnostics(data.diagnostics);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [csvName]);

  // Auto-search on mount if ?sub=NAME is in the URL
  useEffect(() => {
    if (initialSub) {
      doSearch(initialSub);
    }
    // If csv wasn't in the URL, fetch the active CSV name from the
    // dashboard's settings so "already_in_csv" checks work.
    if (!initialCsv) {
      fetch("/api/csv-list")
        .then((r) => r.json())
        .then((data) => {
          const files = data.files || [];
          // Prefer .status.csv files
          const status = files.find((f: any) => f.isStatusFile);
          if (status) setCsvName(status.name);
          else if (files.length > 0) setCsvName(files[0].name);
        })
        .catch(() => {});
    }
  }, []); // run once on mount

  const addToCsv = useCallback(async (sub: SimilarSubreddit) => {
    try {
      const res = await fetch("/api/csv-add-row", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csv: csvName,
          subreddit: sub.name,
          status: "pending",
        }),
      });
      const data = await res.json();
      if (data.ok || data.already_exists) {
        setResults((prev) =>
          prev.map((s) =>
            s.name === sub.name ? { ...s, already_in_csv: true } : s
          )
        );
      } else if (data.error) {
        alert(data.error);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }, [csvName]);

  // Apply sort + filter to results
  const visibleResults = results
    .filter((r) => {
      if (nsfwFilter === "sfw" && r.is_nsfw) return false;
      if (nsfwFilter === "nsfw" && !r.is_nsfw) return false;
      if (r.subscribers < minSubs) return false;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === "subscribers") return b.subscribers - a.subscribers;
      return b.relevance_score - a.relevance_score;
    });

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
      {/* Top bar */}
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-3 flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push("/")}
            className="gap-1.5"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="hidden sm:inline">Back to Dashboard</span>
            <span className="sm:hidden">Back</span>
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Search className="w-5 h-5 text-blue-500" />
            <h1 className="text-base sm:text-xl font-bold tracking-tight">
              Find Similar Subreddits
            </h1>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-3 sm:px-4 py-4 sm:py-6 flex flex-col gap-4">
        {/* Search card */}
        <Card className="border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20">
          <CardHeader className="border-b border-slate-200 dark:border-slate-800 py-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Search className="w-4 h-4" />
              Search
              {csvName && (
                <Badge variant="outline" className="ml-2 text-[10px] py-0 px-1.5 border-slate-300 dark:border-slate-700">
                  CSV: {csvName}
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 space-y-3">
            <div className="flex gap-2 flex-col sm:flex-row">
              <Input
                placeholder="Enter a subreddit name (e.g. animepanties, AskReddit, worldnews)..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && input.trim()) {
                    doSearch(input);
                  }
                }}
                className="flex-1"
                autoFocus
              />
              <Button
                onClick={() => input.trim() && doSearch(input)}
                disabled={loading || !input.trim()}
                className="sm:w-auto"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Search className="w-4 h-4 mr-2" />
                )}
                Search
              </Button>
            </div>
            <p className="text-xs text-slate-500">
              Enter any subreddit — banned, private, or active. We&apos;ll extract keywords
              from its name and description, then search Reddit for similar communities.
              NSFW / private / tiny subreddits are filtered out automatically.
            </p>
          </CardContent>
        </Card>

        {/* Keywords */}
        {keywords.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-slate-500">Keywords extracted:</span>
            {keywords.map((kw) => (
              <Badge key={kw} variant="outline" className="text-[10px] py-0 px-1.5">
                {kw}
              </Badge>
            ))}
            {searchedFor && (
              <span className="text-xs text-slate-500 ml-auto">
                for <span className="font-mono font-semibold">r/{searchedFor}</span>
              </span>
            )}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <Card>
            <CardContent className="pt-6 pb-6 flex items-center justify-center gap-2 text-slate-500">
              <Loader2 className="w-5 h-5 animate-spin" />
              Searching Reddit for similar subreddits...
            </CardContent>
          </Card>
        )}

        {/* Error */}
        {error && !loading && (
          <Card className="border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-950/20">
            <CardContent className="pt-6">
              <div className="flex items-start gap-3 text-red-700 dark:text-red-300">
                <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="font-semibold">Search failed</p>
                  <p className="text-sm mt-1">{error}</p>
                  <p className="text-xs mt-2 text-slate-500">
                    If Reddit is rate-limiting you, wait a minute and try again.
                    If you searched for a user account (u_ prefix), Find Similar only
                    works for subreddits.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Results header + filters */}
        {!loading && !error && results.length > 0 && (
          <Card>
            <CardHeader className="border-b border-slate-200 dark:border-slate-800 py-3">
              <CardTitle className="text-base flex items-center justify-between gap-2 flex-wrap">
                <span className="flex items-center gap-2">
                  <Users className="w-4 h-4" />
                  Results ({visibleResults.length} shown)
                </span>
                <div className="flex flex-wrap gap-2 items-center">
                  <Select value={sortBy} onValueChange={(v) => setSortBy(v as "relevance" | "subscribers")}>
                    <SelectTrigger className="w-[130px] h-8">
                      <SelectValue placeholder="Sort by" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="relevance">Relevance</SelectItem>
                      <SelectItem value="subscribers">Subscribers</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={nsfwFilter} onValueChange={(v) => setNsfwFilter(v as any)}>
                    <SelectTrigger className="w-[120px] h-8">
                      <SelectValue placeholder="Content" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All content</SelectItem>
                      <SelectItem value="sfw">SFW only</SelectItem>
                      <SelectItem value="nsfw">NSFW only</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-1.5">
                    <Label className="text-xs">Min subs:</Label>
                    <Input
                      type="number"
                      value={minSubs}
                      onChange={(e) => setMinSubs(parseInt(e.target.value) || 0)}
                      className="w-20 h-8 text-xs"
                    />
                  </div>
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="space-y-2">
                {visibleResults.map((r) => (
                  <div
                    key={r.name}
                    className="flex items-center gap-3 p-2.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-blue-300 dark:hover:border-blue-700"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <a
                          href={r.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-semibold text-slate-900 dark:text-slate-100 hover:text-blue-600 dark:hover:text-blue-400 text-sm flex items-center gap-1"
                        >
                          r/{r.name}
                          <ExternalLink className="w-3 h-3 opacity-50" />
                        </a>
                        {r.is_nsfw && (
                          <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-rose-300 text-rose-700 dark:border-rose-700 dark:text-rose-300">
                            NSFW
                          </Badge>
                        )}
                        {r.already_in_csv && (
                          <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300">
                            <CheckCircle2 className="w-3 h-3 mr-0.5" />
                            In CSV
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2 mt-0.5">
                        {r.description || r.display_name || "—"}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <div className="text-right">
                        <p className="text-xs font-mono text-slate-700 dark:text-slate-300">
                          {formatNumber(r.subscribers)}
                        </p>
                        <p className="text-[10px] text-slate-500">subs</p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs font-mono text-blue-600 dark:text-blue-400">
                          {r.relevance_score}
                        </p>
                        <p className="text-[10px] text-slate-500">match</p>
                      </div>
                      <Button
                        size="sm"
                        variant={r.already_in_csv ? "secondary" : "outline"}
                        className="h-8 text-xs gap-1"
                        onClick={() => addToCsv(r)}
                        disabled={r.already_in_csv}
                        title={r.already_in_csv ? "Already in your CSV" : "Add to CSV as pending"}
                      >
                        {r.already_in_csv ? (
                          <>
                            <CheckCircle2 className="w-3 h-3" />
                            Added
                          </>
                        ) : (
                          <>
                            <Plus className="w-3 h-3" />
                            Add
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Empty state — with diagnostics when available */}
        {!loading && !error && searchedFor && results.length === 0 && (
          <Card>
            <CardContent className="pt-6 pb-6">
              <div className="text-center text-slate-500 mb-4">
                <Search className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="font-medium">No similar subreddits found for r/{searchedFor}</p>
                <p className="text-xs mt-1">
                  Check the diagnostics below — they show what Reddit returned for each request.
                  If you see 403 statuses, your browser profile may not be authenticated, or
                  Reddit detected the bot. Try running a normal subscriber session first so the
                  browser profile saves fresh cookies.
                </p>
              </div>

              {/* Diagnostics — show what each HTTP request returned */}
              {diagnostics.length > 0 && (
                <div className="mt-4 border-t border-slate-200 dark:border-slate-800 pt-4">
                  <p className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
                    Diagnostics ({diagnostics.length} HTTP requests made):
                  </p>
                  <div className="space-y-2 max-h-[400px] overflow-auto">
                    {diagnostics.map((d, i) => (
                      <div
                        key={i}
                        className={cn(
                          "p-2 rounded border text-xs font-mono",
                          d.is_json
                            ? "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800"
                            : d.status === 403 || d.status === 401
                            ? "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800"
                            : "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800"
                        )}
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold">{d.step}</span>
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[10px] py-0 px-1.5",
                              d.status === 200
                                ? "border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300"
                                : d.status === 403 || d.status === 401
                                ? "border-red-300 text-red-700 dark:border-red-700 dark:text-red-300"
                                : "border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300"
                            )}
                          >
                            HTTP {d.status}
                          </Badge>
                          {d.is_json ? (
                            <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300">
                              JSON
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px] py-0 px-1.5 border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300">
                              HTML
                            </Badge>
                          )}
                          {d.duration_ms > 0 && (
                            <span className="text-slate-500">{d.duration_ms}ms</span>
                          )}
                        </div>
                        {d.url && (
                          <p className="text-slate-500 mt-1 break-all">URL: {d.url}</p>
                        )}
                        {d.body_snippet && (
                          <p className="text-slate-600 dark:text-slate-400 mt-1 break-all">
                            Body: {d.body_snippet.slice(0, 200)}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-slate-500 mt-3">
                    Full diagnostics are also logged to the <button onClick={() => router.push('/logs')} className="text-blue-600 dark:text-blue-400 underline">server logs</button> at DEBUG level.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Initial state — no search yet */}
        {!loading && !error && !searchedFor && (
          <Card>
            <CardContent className="pt-12 pb-12 text-center text-slate-500">
              <Search className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium">Find similar subreddits</p>
              <p className="text-xs mt-1 max-w-md mx-auto">
                Enter a subreddit name above and we&apos;ll find similar communities
                based on its name and description keywords. Click <strong>Add</strong> on
                any result to add it to your CSV as <code className="font-mono">pending</code>.
              </p>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}

export default function FindSimilarPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
        </div>
      }
    >
      <FindSimilarContent />
    </Suspense>
  );
}
