import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import fsSync from "fs";

// ============================================================
// Find similar subreddits for a banned subreddit.
//
// POST /api/find-similar
// Body: {
//   subreddit: "animepanties",   // the banned subreddit name
// }
//
// Algorithm:
// 1. Fetch the banned subreddit's about.json (even banned subs return
//    some metadata: title, description, public_description)
// 2. Extract keywords from the name + description
// 3. Search /subreddits/search.json?q={keywords} for matching communities
// 4. For each result, check if it's already in the user's CSV
// 5. Filter out: private, quarantined, <100 subscribers
// 6. Rank by keyword relevance + subscriber count
// 7. Return the top 20 results with metadata
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

// Fetch JSON from Reddit with proper User-Agent
async function fetchRedditJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${url}`);
  }
  return res.json();
}

// Extract keywords from a subreddit name + description
function extractKeywords(name: string, description: string): string[] {
  const keywords = new Set<string>();

  // Split the subreddit name into words (camelCase, snake_case, etc.)
  // e.g. "animepanties" → ["anime", "panties"]
  //      "Anime_Panties" → ["anime", "panties"]
  //      "GirlsInPajamas" → ["girls", "in", "pajamas"]
  const nameWords = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")  // camelCase split
    .replace(/[_\-\s]+/g, " ")              // snake/kebab to spaces
    .toLowerCase()
    .split(" ")
    .filter(w => w.length >= 3);            // skip short words

  for (const word of nameWords) {
    keywords.add(word);
  }

  // Extract keywords from the description
  const descWords = description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(" ")
    .filter(w => w.length >= 4);  // only words >= 4 chars from description

  // Common stop words to exclude
  const stopWords = new Set([
    "this", "that", "with", "from", "have", "they", "will", "what",
    "when", "your", "about", "which", "their", "would", "there",
    "could", "other", "more", "some", "than", "very", "just",
    "into", "over", "such", "also", "after", "before", "been",
    "were", "them", "these", "those", "only", "then", "where",
    "here", "post", "share", "like", "subreddit", "community",
    "reddit", "content", "discussion", "please", "follow",
    "rules", "must", "should", "posts", "images", "videos",
    "picture", "photo", "photos",
  ]);

  // Add top description keywords (max 5)
  const descKeywordCounts: Record<string, number> = {};
  for (const word of descWords) {
    if (!stopWords.has(word)) {
      descKeywordCounts[word] = (descKeywordCounts[word] || 0) + 1;
    }
  }
  const topDescKeywords = Object.entries(descKeywordCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);

  for (const word of topDescKeywords) {
    keywords.add(word);
  }

  return Array.from(keywords).slice(0, 8);  // max 8 keywords
}

// Check if a subreddit is already in the user's CSV
async function isAlreadyInCsv(
  csvRoot: string,
  csvName: string | undefined,
  subredditName: string
): Promise<boolean> {
  if (!csvName) return false;
  const csvPath = path.isAbsolute(csvName) ? csvName : path.join(csvRoot, csvName);
  try {
    const text = await fs.readFile(csvPath, "utf-8");
    const normalizedName = subredditName.toLowerCase();
    // Quick check — just search the text
    return text.toLowerCase().includes(normalizedName);
  } catch {
    return false;
  }
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

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const subredditName = (body.subreddit || "").trim();
    const csvName = body.csv;  // CSV filename passed from the client

    if (!subredditName) {
      return NextResponse.json(
        { error: "Missing 'subreddit' field" },
        { status: 400 }
      );
    }

    // Strip r/ prefix
    const cleanName = subredditName.replace(/^r\//i, "").replace(/^\/r\//i, "");

    const csvRoot = await getCsvRoot();

    // Step 1: Fetch the banned subreddit's about.json
    // Even banned subreddits return metadata (title, description)
    let description = "";
    let displayName = cleanName;
    try {
      const aboutData = await fetchRedditJson(
        `https://www.reddit.com/r/${encodeURIComponent(cleanName)}/about.json`
      );
      const data = aboutData?.data;
      if (data) {
        description = data.public_description || data.description || "";
        displayName = data.display_name || cleanName;
      }
    } catch {
      // If we can't fetch about.json, proceed with just the name
    }

    // Step 2: Extract keywords
    const keywords = extractKeywords(cleanName, description);
    if (keywords.length === 0) {
      return NextResponse.json({
        subreddit: cleanName,
        keywords: [],
        results: [],
        message: "Could not extract keywords from subreddit name",
      });
    }

    // Step 3: Search for similar subreddits using keywords
    const searchQuery = keywords.slice(0, 4).join(" ");
    let searchResults: any[] = [];
    try {
      const searchData = await fetchRedditJson(
        `https://www.reddit.com/subreddits/search.json?q=${encodeURIComponent(searchQuery)}&limit=25&sort=relevance`
      );
      searchResults = searchData?.data?.children?.map((c: any) => c.data) || [];
    } catch {
      // Search failed — try with fewer keywords
      try {
        const searchData = await fetchRedditJson(
          `https://www.reddit.com/subreddits/search.json?q=${encodeURIComponent(keywords[0])}&limit=25`
        );
        searchResults = searchData?.data?.children?.map((c: any) => c.data) || [];
      } catch {}
    }

    // Step 4: Process results
    const results: SimilarSubreddit[] = [];
    const seen = new Set<string>();

    for (const sub of searchResults) {
      const name = sub.display_name || "";
      if (!name || name.toLowerCase() === cleanName.toLowerCase()) continue;
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());

      // Skip private, quarantined subreddits
      if (sub.subreddit_type === "private" || sub.quarantine) continue;

      const subscribers = sub.subscribers || 0;

      // Skip tiny subreddits (< 100 subscribers)
      if (subscribers < 100) continue;

      // Calculate relevance score based on keyword overlap
      const subNameLower = (sub.display_name || "").toLowerCase();
      const subDescLower = (sub.public_description || "").toLowerCase();
      let relevanceScore = 0;
      for (const kw of keywords) {
        if (subNameLower.includes(kw)) relevanceScore += 3;
        if (subDescLower.includes(kw)) relevanceScore += 1;
      }

      // Check if already in CSV
      const alreadyInCsv = await isAlreadyInCsv(csvRoot, csvName, name);

      results.push({
        name,
        display_name: sub.title || sub.display_name || name,
        subscribers,
        description: sub.public_description || "",
        is_nsfw: sub.over18 === true,
        relevance_score: relevanceScore,
        already_in_csv: alreadyInCsv,
        url: `https://www.reddit.com/r/${name}`,
      });
    }

    // Step 5: Sort by relevance score (then by subscribers)
    results.sort((a, b) => {
      if (b.relevance_score !== a.relevance_score) {
        return b.relevance_score - a.relevance_score;
      }
      return b.subscribers - a.subscribers;
    });

    // Return top 20
    const topResults = results.slice(0, 20);

    return NextResponse.json({
      subreddit: cleanName,
      display_name: displayName,
      keywords,
      results: topResults,
      total_found: results.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to find similar subreddits: ${message}` },
      { status: 500 }
    );
  }
}
