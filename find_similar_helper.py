#!/usr/bin/env python3
"""
Find Similar helper — fetches subreddit info and search results from Reddit
using the saved Playwright browser profile (which has the user's login cookies).

WHY THIS EXISTS:
  As of late May 2026, Reddit killed unauthenticated .json endpoint access.
  Plain `fetch('https://www.reddit.com/r/NAME/about.json')` returns 403
  Forbidden (an HTML block page) instead of JSON. The ONLY way to get
  JSON from Reddit now is via an authenticated browser session — which
  we already have in the saved Playwright profile (~/.reddit_subscriber_profile)
  that the main subscriber script uses for browsing.

USAGE:
  python3 find_similar_helper.py --subreddit NAME [--csv-root DIR]

OUTPUT:
  Prints a single JSON line on stdout:
    {
      "ok": true,
      "subreddit": "NAME",
      "display_name": "...",
      "description": "...",
      "subscribers": 12345,
      "is_nsfw": false,
      "is_banned": false,
      "is_private": false,
      "keywords": ["kw1", "kw2", ...],
      "search_results": [
        {
          "name": "...",
          "display_name": "...",
          "subscribers": 12345,
          "description": "...",
          "is_nsfw": false,
          "is_quarantined": false,
          "subreddit_type": "public",
          "url": "https://www.reddit.com/r/..."
        },
        ...
      ]
    }

  Or on error:
    { "ok": false, "error": "human-readable error message" }
"""

import argparse
import json
import os
import re
import sys
import urllib.parse
from pathlib import Path


# ============================================================
# Keyword extraction — mirrors the logic the TS find-similar
# route used to do, but now we do it in Python so we can use
# the description fetched via the browser profile.
# ============================================================

STOP_WORDS = {
    "this", "that", "with", "from", "have", "they", "will", "what",
    "when", "your", "about", "which", "their", "would", "there",
    "could", "other", "more", "some", "than", "very", "just",
    "into", "over", "such", "also", "after", "before", "been",
    "were", "them", "these", "those", "only", "then", "where",
    "here", "post", "share", "like", "subreddit", "community",
    "reddit", "content", "discussion", "please", "follow",
    "rules", "must", "should", "posts", "images", "videos",
    "picture", "photo", "photos", "welcome", "place", "talk",
}


def extract_keywords(name: str, description: str):
    """Extract keywords from a subreddit name + description."""
    keywords = []

    # Split the subreddit name into words (camelCase, snake_case, etc.)
    # e.g. "animepanties" → ["anime", "panties"]
    #      "Anime_Panties" → ["anime", "panties"]
    #      "GirlsInPajamas" → ["girls", "in", "pajamas"]
    name_words = (
        re.sub(r"([a-z])([A-Z])", r"\1 \2", name)  # camelCase split
        .replace("_", " ").replace("-", " ")
        .lower()
        .split(" ")
    )
    for w in name_words:
        if len(w) >= 3 and w not in STOP_WORDS:
            keywords.append(w)

    # Extract keywords from the description
    desc_words = re.sub(r"[^a-z0-9\s]", " ", description.lower()).split(" ")
    desc_counts = {}
    for w in desc_words:
        if len(w) >= 4 and w not in STOP_WORDS:
            desc_counts[w] = desc_counts.get(w, 0) + 1
    # Top 5 description keywords by frequency
    top_desc = sorted(desc_counts.items(), key=lambda x: -x[1])[:5]
    for w, _ in top_desc:
        if w not in keywords:
            keywords.append(w)

    # Deduplicate while preserving order; cap at 8
    seen = set()
    deduped = []
    for k in keywords:
        if k not in seen:
            seen.add(k)
            deduped.append(k)
        if len(deduped) >= 8:
            break
    return deduped


# ============================================================
# Fetch JSON from Reddit via the browser profile's cookies.
# Uses Playwright with launch_persistent_context — same approach
# as the working fetch_subscribed_subreddits() in the main script.
# ============================================================

def fetch_reddit_json(page, url, timeout_ms=30000):
    """Navigate to a .json URL and return the parsed JSON body.

    Returns: (status_code, json_or_text, is_json)
      - status_code: HTTP status (0 if navigation failed)
      - json_or_text: parsed JSON if is_json, else the raw body text
      - is_json: True if the body parsed as JSON

    Detects HTML responses (rate-limit page, login redirect, 403 block
    page) and returns them with is_json=False so callers can give a
    clear error message instead of "Expecting value: line 1 column 1".
    """
    try:
        response = page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
    except Exception as exc:
        return 0, f"navigation error: {exc}", False

    status = response.status if response else 0

    try:
        body = response.text()
    except Exception as exc:
        return status, f"could not read body: {exc}", False

    stripped = body.lstrip()[:200]
    if not (stripped.startswith("{") or stripped.startswith("[")):
        return status, body, False

    try:
        return status, json.loads(body), True
    except Exception as exc:
        return status, body, False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--subreddit", required=True, help="Subreddit name to find similar subreddits for")
    parser.add_argument("--csv-root", default=None, help="CSV root directory (for profile dir resolution)")
    args = parser.parse_args()

    subreddit_name = args.subreddit.strip()
    # Strip r/ prefix
    if subreddit_name.lower().startswith("r/"):
        subreddit_name = subreddit_name[2:]
    subreddit_name = subreddit_name.strip("/")

    # Reject user profiles — they don't have /r/ about.json
    if subreddit_name.lower().startswith("u_") or subreddit_name.lower().startswith("u/"):
        print(json.dumps({
            "ok": False,
            "error": f"'{subreddit_name}' looks like a user profile (u_ prefix). Find Similar only works for subreddits.",
        }))
        sys.exit(0)

    # Locate the browser profile dir
    profile_dir = os.environ.get("REDDIT_PROFILE_DIR") or str(
        Path.home() / ".reddit_subscriber_profile"
    )
    if not os.path.isdir(profile_dir):
        print(json.dumps({
            "ok": False,
            "error": (
                f"Browser profile not found at {profile_dir}. "
                f"You need to start a normal subscriber run first so the browser "
                f"can save your login cookies — Reddit now requires authentication "
                f"for ALL .json endpoints (since May 2026)."
            ),
        }))
        sys.exit(0)

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(json.dumps({
            "ok": False,
            "error": "Playwright is not installed. Run: pip install playwright && playwright install chromium",
        }))
        sys.exit(0)

    display_name = subreddit_name
    description = ""
    subscribers = 0
    is_nsfw = False
    is_banned = False
    is_private = False

    search_results = []

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch_persistent_context(
                user_data_dir=profile_dir,
                headless=True,
                user_agent=(
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                ),
                viewport={"width": 1280, "height": 800},
                java_script_enabled=False,  # we only need raw JSON
            )
            page = browser.new_page()
            page.set_extra_http_headers({
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "en-US,en;q=0.9",
            })

            # --- Step 1: Fetch /r/NAME/about.json ---
            about_url = f"https://www.reddit.com/r/{urllib.parse.quote(subreddit_name)}/about.json"
            status, data, is_json = fetch_reddit_json(page, about_url)

            if status == 403 or status == 401:
                # Not authenticated — profile cookies are gone/expired
                browser.close()
                print(json.dumps({
                    "ok": False,
                    "error": (
                        f"Reddit returned HTTP {status} for /r/{subreddit_name}/about.json. "
                        f"Your browser profile is not authenticated. Start a normal "
                        f"subscriber run first so the browser can save your login cookies."
                    ),
                }))
                sys.exit(0)

            if status == 404:
                # Subreddit doesn't exist
                browser.close()
                print(json.dumps({
                    "ok": False,
                    "error": f"Subreddit r/{subreddit_name} does not exist (404).",
                }))
                sys.exit(0)

            if is_json and isinstance(data, dict):
                d = data.get("data", {}) if isinstance(data.get("data"), dict) else {}
                if d:
                    description = d.get("public_description") or d.get("description") or ""
                    display_name = d.get("display_name") or subreddit_name
                    subscribers = d.get("subscribers") or 0
                    is_nsfw = bool(d.get("over18"))
                    sub_type = (d.get("subreddit_type") or "").lower()
                    if sub_type == "private":
                        is_private = True
                    if sub_type == "archived" or "banned" in str(d.get("description") or "").lower():
                        # Reddit sometimes bans subs and the about.json shows it
                        pass
                    # Reddit returns error field for banned subs
                    if data.get("error") == 404 or "banned" in str(data).lower()[:500]:
                        is_banned = True
            elif not is_json and status != 0:
                # Got HTML (rate limit, etc.) — proceed with name-only keywords
                pass

            # --- Step 2: Extract keywords ---
            keywords = extract_keywords(subreddit_name, description)

            if not keywords:
                # Fall back to the bare name
                keywords = [subreddit_name.lower()]

            # --- Step 3: Search for similar subreddits ---
            # Try multiple query strategies:
            #   1. All keywords joined
            #   2. First 2 keywords
            #   3. First keyword only
            # Combine + dedupe results.
            queries = []
            if len(keywords) >= 3:
                queries.append(" ".join(keywords[:4]))
                queries.append(" ".join(keywords[:2]))
            elif len(keywords) >= 2:
                queries.append(" ".join(keywords[:2]))
            queries.append(keywords[0])
            # Also try the subreddit name itself as a search query
            queries.append(subreddit_name)

            seen_names = set()
            seen_names.add(subreddit_name.lower())

            for query in queries:
                search_url = (
                    f"https://www.reddit.com/subreddits/search.json"
                    f"?q={urllib.parse.quote(query)}&limit=25&sort=relevance"
                )
                s_status, s_data, s_is_json = fetch_reddit_json(page, search_url, timeout_ms=30000)

                if not s_is_json or not isinstance(s_data, dict):
                    # Rate-limited or HTML — try the next query
                    continue

                children = s_data.get("data", {}).get("children", [])
                if not children:
                    continue

                for child in children:
                    d = child.get("data", {}) if isinstance(child, dict) else {}
                    name = d.get("display_name", "")
                    if not name:
                        continue
                    if name.lower() in seen_names:
                        continue
                    seen_names.add(name.lower())

                    # Skip private / quarantined subreddits
                    sub_type = (d.get("subreddit_type") or "").lower()
                    if sub_type == "private":
                        continue
                    if d.get("quarantine"):
                        continue

                    sub_count = d.get("subscribers") or 0
                    if sub_count < 100:
                        continue  # skip tiny subreddits

                    search_results.append({
                        "name": name,
                        "display_name": d.get("title") or name,
                        "subscribers": sub_count,
                        "description": d.get("public_description") or "",
                        "is_nsfw": bool(d.get("over18")),
                        "is_quarantined": bool(d.get("quarantine")),
                        "subreddit_type": sub_type or "public",
                        "url": f"https://www.reddit.com/r/{name}",
                    })

                # Stop early if we already have plenty of results
                if len(search_results) >= 30:
                    break

            browser.close()

        # Build the response
        print(json.dumps({
            "ok": True,
            "subreddit": subreddit_name,
            "display_name": display_name,
            "description": description,
            "subscribers": subscribers,
            "is_nsfw": is_nsfw,
            "is_banned": is_banned,
            "is_private": is_private,
            "keywords": keywords,
            "search_results": search_results,
            "queries_used": queries,
        }))

    except Exception as exc:
        # Catch-all so the TS side always gets JSON
        print(json.dumps({
            "ok": False,
            "error": f"Unexpected error: {type(exc).__name__}: {exc}",
        }))
        sys.exit(0)


if __name__ == "__main__":
    main()
