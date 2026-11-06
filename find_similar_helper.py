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

CRITICAL FIX (previous version returned 0 results):
  The previous helper was missing TWO things the main subscriber script has:
    1. playwright-stealth library (Stealth().apply_stealth_sync) — patches
       navigator.webdriver, chrome.runtime, plugins, languages, etc.
       Without this, Reddit detects Playwright via `navigator.webdriver=true`
       and serves a 403 block page even when authenticated.
    2. --disable-blink-features=AutomationControlled launch arg — removes
       the `cdc_` (Chrome DevTools Conductor) prefix from DOM properties
       that bot-detection scripts look for.
    3. java_script_enabled=False was a HUGE red flag — Reddit's bot detection
       runs JS to check for various browser features. Disabling JS makes
       us look like a bot. Now JS is ENABLED.

  Plus: the previous helper only tried /subreddits/search.json which may
  have been deprecated. Now we try THREE endpoints:
    1. /subreddits/search.json?q=...&limit=25&sort=relevance  (legacy)
    2. /search/.json?q=...&type=sr&limit=25&sort=relevance     (newer)
    3. /api/search_subreddits  (POST, returns partial subreddit objects)

  Plus: every request now captures diagnostics (status, content-type, body
  snippet) so when something fails, the dashboard logs show EXACTLY what
  Reddit returned instead of just "0 results".

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
      "search_results": [...],
      "queries_used": [...],
      "diagnostics": [
        {
          "step": "fetch_about",
          "url": "https://www.reddit.com/r/NAME/about.json",
          "status": 200,
          "content_type": "application/json",
          "body_snippet": "{\"kind\": \"t5\", \"data\": {...",
          "is_json": true,
          "duration_ms": 234
        },
        ...
      ]
    }
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.parse
from pathlib import Path


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
    name_words = (
        re.sub(r"([a-z])([A-Z])", r"\1 \2", name)
        .replace("_", " ").replace("-", " ")
        .lower()
        .split(" ")
    )
    for w in name_words:
        if len(w) >= 3 and w not in STOP_WORDS:
            keywords.append(w)

    desc_words = re.sub(r"[^a-z0-9\s]", " ", description.lower()).split(" ")
    desc_counts = {}
    for w in desc_words:
        if len(w) >= 4 and w not in STOP_WORDS:
            desc_counts[w] = desc_counts.get(w, 0) + 1
    top_desc = sorted(desc_counts.items(), key=lambda x: -x[1])[:5]
    for w, _ in top_desc:
        if w not in keywords:
            keywords.append(w)

    seen = set()
    deduped = []
    for k in keywords:
        if k not in seen:
            seen.add(k)
            deduped.append(k)
        if len(deduped) >= 8:
            break
    return deduped


def fetch_reddit_json(page, url, timeout_ms=30000, diagnostics=None, step_name=""):
    """Navigate to a .json URL and return (status, parsed_or_text, is_json, content_type).

    Captures detailed diagnostics so failures can be debugged from the logs.
    """
    start = time.time()
    try:
        response = page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
    except Exception as exc:
        if diagnostics is not None:
            diagnostics.append({
                "step": step_name,
                "url": url,
                "status": 0,
                "content_type": "",
                "body_snippet": f"navigation error: {exc}",
                "is_json": False,
                "duration_ms": int((time.time() - start) * 1000),
            })
        return 0, f"navigation error: {exc}", False, ""

    status = response.status if response else 0
    content_type = ""
    if response:
        try:
            headers = response.headers
            content_type = headers.get("content-type", "")
        except Exception:
            pass

    try:
        body = response.text()
    except Exception as exc:
        if diagnostics is not None:
            diagnostics.append({
                "step": step_name,
                "url": url,
                "status": status,
                "content_type": content_type,
                "body_snippet": f"could not read body: {exc}",
                "is_json": False,
                "duration_ms": int((time.time() - start) * 1000),
            })
        return status, f"could not read body: {exc}", False, content_type

    stripped = body.lstrip()[:200]
    is_json = stripped.startswith("{") or stripped.startswith("[")

    if is_json:
        try:
            parsed = json.loads(body)
            if diagnostics is not None:
                diagnostics.append({
                    "step": step_name,
                    "url": url,
                    "status": status,
                    "content_type": content_type,
                    "body_snippet": stripped[:200],
                    "is_json": True,
                    "duration_ms": int((time.time() - start) * 1000),
                })
            return status, parsed, True, content_type
        except Exception as exc:
            if diagnostics is not None:
                diagnostics.append({
                    "step": step_name,
                    "url": url,
                    "status": status,
                    "content_type": content_type,
                    "body_snippet": f"json parse failed: {exc} | body_start: {stripped[:150]}",
                    "is_json": False,
                    "duration_ms": int((time.time() - start) * 1000),
                })
            return status, body, False, content_type
    else:
        # HTML response (or empty) — capture a snippet for debugging
        snippet = body.replace("\n", " ").replace("\r", " ").strip()[:200]
        if diagnostics is not None:
            diagnostics.append({
                "step": step_name,
                "url": url,
                "status": status,
                "content_type": content_type,
                "body_snippet": snippet,
                "is_json": False,
                "duration_ms": int((time.time() - start) * 1000),
            })
        return status, body, False, content_type


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--subreddit", required=True)
    parser.add_argument("--csv-root", default=None)
    args = parser.parse_args()

    subreddit_name = args.subreddit.strip()
    if subreddit_name.lower().startswith("r/"):
        subreddit_name = subreddit_name[2:]
    subreddit_name = subreddit_name.strip("/")

    if subreddit_name.lower().startswith("u_") or subreddit_name.lower().startswith("u/"):
        print(json.dumps({
            "ok": False,
            "error": f"'{subreddit_name}' looks like a user profile (u_ prefix). Find Similar only works for subreddits.",
        }))
        sys.exit(0)

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

    # Try to import playwright-stealth (the main subscriber script uses this).
    # Without it, Reddit detects navigator.webdriver=true and serves 403.
    stealth = None
    try:
        from playwright_stealth import Stealth
        stealth = Stealth()
    except ImportError:
        # Will continue without stealth but warn in diagnostics
        pass

    display_name = subreddit_name
    description = ""
    subscribers = 0
    is_nsfw = False
    is_banned = False
    is_private = False
    search_results = []
    diagnostics = []

    try:
        with sync_playwright() as p:
            # CRITICAL: use the SAME launch config as the main subscriber script.
            #   - --disable-blink-features=AutomationControlled removes the
            #     navigator.webdriver flag
            #   - playwright-stealth patches dozens of other bot-detection signals
            #   - JavaScript MUST be enabled (Reddit's bot detection runs JS)
            # Without these, Reddit 403s all .json requests even when authed.
            launch_args = [
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
            ]
            browser = p.chromium.launch_persistent_context(
                user_data_dir=profile_dir,
                headless=True,
                args=launch_args,
                viewport={"width": 1280, "height": 800},
                locale="en-US",
                timezone_id="America/Chicago",
                java_script_enabled=True,  # MUST be True — Reddit detects JS-disabled browsers
            )

            # Apply stealth evasions if available
            if stealth is not None:
                try:
                    stealth.apply_stealth_sync(browser)
                    diagnostics.append({
                        "step": "stealth_apply",
                        "url": "",
                        "status": 200,
                        "content_type": "",
                        "body_snippet": "playwright-stealth applied successfully",
                        "is_json": False,
                        "duration_ms": 0,
                    })
                except Exception as exc:
                    diagnostics.append({
                        "step": "stealth_apply",
                        "url": "",
                        "status": 0,
                        "content_type": "",
                        "body_snippet": f"stealth apply failed: {exc}",
                        "is_json": False,
                        "duration_ms": 0,
                    })
            else:
                diagnostics.append({
                    "step": "stealth_apply",
                    "url": "",
                    "status": 0,
                    "content_type": "",
                    "body_snippet": "playwright-stealth NOT installed — bot detection may trigger 403",
                    "is_json": False,
                    "duration_ms": 0,
                })

            page = browser.new_page()
            page.set_extra_http_headers({
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "en-US,en;q=0.9",
            })

            # --- Step 1: Fetch /r/NAME/about.json ---
            about_url = f"https://www.reddit.com/r/{urllib.parse.quote(subreddit_name)}/about.json"
            status, data, is_json, ct = fetch_reddit_json(
                page, about_url, diagnostics=diagnostics, step_name="fetch_about"
            )

            if status == 403 or status == 401:
                browser.close()
                print(json.dumps({
                    "ok": False,
                    "error": (
                        f"Reddit returned HTTP {status} for /r/{subreddit_name}/about.json. "
                        f"Your browser profile is not authenticated OR Reddit detected the browser "
                        f"as a bot. Make sure playwright-stealth is installed (pip install playwright-stealth) "
                        f"and you've logged in via a normal subscriber run."
                    ),
                    "diagnostics": diagnostics,
                }))
                sys.exit(0)

            if status == 404:
                browser.close()
                print(json.dumps({
                    "ok": False,
                    "error": f"Subreddit r/{subreddit_name} does not exist (404).",
                    "diagnostics": diagnostics,
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
                    if data.get("error") == 404 or "banned" in str(d.get("description") or "").lower():
                        is_banned = True
            elif not is_json and status != 0:
                # Got HTML — proceed with name-only keywords.
                # Diagnostics already captured what Reddit returned.
                pass

            # --- Step 2: Extract keywords ---
            keywords = extract_keywords(subreddit_name, description)
            if not keywords:
                keywords = [subreddit_name.lower()]

            # --- Step 3: Search for similar subreddits ---
            # Try MULTIPLE endpoints — Reddit has changed these over time.
            # We try each one in order until we get results.
            queries = []
            if len(keywords) >= 3:
                queries.append(" ".join(keywords[:4]))
                queries.append(" ".join(keywords[:2]))
            elif len(keywords) >= 2:
                queries.append(" ".join(keywords[:2]))
            queries.append(keywords[0])
            queries.append(subreddit_name)

            seen_names = set()
            seen_names.add(subreddit_name.lower())

            # Try each endpoint pattern with each query.
            # Stop early once we have enough results.
            ENDPOINT_PATTERNS = [
                # Legacy endpoint — older scripts use this
                ("GET", "https://www.reddit.com/subreddits/search.json?q={q}&limit=25&sort=relevance", "search_legacy"),
                # Newer endpoint — /search/.json with type=sr filter
                ("GET", "https://www.reddit.com/search/.json?q={q}&type=sr&limit=25&sort=relevance", "search_new"),
                # Alternate form without trailing slash
                ("GET", "https://www.reddit.com/search.json?q={q}&type=sr&limit=25&sort=relevance", "search_alt"),
            ]

            for query in queries:
                if len(search_results) >= 30:
                    break

                for method, url_template, step_name in ENDPOINT_PATTERNS:
                    if len(search_results) >= 30:
                        break

                    url = url_template.format(q=urllib.parse.quote(query))
                    s_status, s_data, s_is_json, s_ct = fetch_reddit_json(
                        page, url, diagnostics=diagnostics, step_name=f"{step_name}[{query[:30]}]"
                    )

                    if not s_is_json or not isinstance(s_data, dict):
                        # Move to next endpoint pattern
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

                        sub_type = (d.get("subreddit_type") or "").lower()
                        if sub_type == "private":
                            continue
                        if d.get("quarantine"):
                            continue

                        sub_count = d.get("subscribers") or 0
                        if sub_count < 100:
                            continue

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

            # --- Step 4: Try POST /api/search_subreddits as a last resort ---
            # This endpoint returns partial subreddit objects. It's the official
            # API endpoint that powers Reddit's "search subreddits" UI.
            # Only try it if we have very few results so far.
            if len(search_results) < 5:
                for query in queries[:2]:
                    if len(search_results) >= 30:
                        break
                    try:
                        # Use page.evaluate to make a fetch() call from within
                        # the browser context — this carries all cookies + headers
                        # automatically and bypasses CORS.
                        result = page.evaluate(
                            """
                            async (query) => {
                                try {
                                    const res = await fetch('https://www.reddit.com/api/search_subreddits', {
                                        method: 'POST',
                                        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                                        body: 'query=' + encodeURIComponent(query) + '&include_unadvertisable=true'
                                    });
                                    const status = res.status;
                                    const text = await res.text();
                                    return {status: status, body: text.slice(0, 5000), body_snippet: text.slice(0, 200)};
                                } catch (e) {
                                    return {status: 0, body: '', body_snippet: 'fetch error: ' + String(e)};
                                }
                            }
                            """,
                            query
                        )
                        diagnostics.append({
                            "step": f"search_api_post[{query[:30]}]",
                            "url": "https://www.reddit.com/api/search_subreddits",
                            "status": result.get("status", 0),
                            "content_type": "",
                            "body_snippet": result.get("body_snippet", "")[:200],
                            "is_json": result.get("body", "").lstrip().startswith(("{", "[")),
                            "duration_ms": 0,
                        })

                        if result.get("status") == 200:
                            try:
                                api_data = json.loads(result.get("body", ""))
                                if isinstance(api_data, dict):
                                    api_children = api_data.get("subreddits", [])
                                    for sub in api_children:
                                        name = sub.get("name", "")
                                        if not name or name.lower() in seen_names:
                                            continue
                                        seen_names.add(name.lower())
                                        sub_count = sub.get("subscribers") or 0
                                        if sub_count < 100:
                                            continue
                                        search_results.append({
                                            "name": name,
                                            "display_name": sub.get("title") or name,
                                            "subscribers": sub_count,
                                            "description": sub.get("public_description") or "",
                                            "is_nsfw": bool(sub.get("over18")),
                                            "is_quarantined": False,
                                            "subreddit_type": "public",
                                            "url": f"https://www.reddit.com/r/{name}",
                                        })
                            except Exception as exc:
                                diagnostics.append({
                                    "step": f"search_api_post_parse[{query[:30]}]",
                                    "url": "",
                                    "status": 0,
                                    "content_type": "",
                                    "body_snippet": f"parse error: {exc}",
                                    "is_json": False,
                                    "duration_ms": 0,
                                })
                    except Exception as exc:
                        diagnostics.append({
                            "step": f"search_api_post[{query[:30]}]",
                            "url": "",
                            "status": 0,
                            "content_type": "",
                            "body_snippet": f"evaluate error: {exc}",
                            "is_json": False,
                            "duration_ms": 0,
                        })

            browser.close()

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
            "diagnostics": diagnostics,
        }))

    except Exception as exc:
        # Catch-all so the TS side always gets JSON
        print(json.dumps({
            "ok": False,
            "error": f"Unexpected error: {type(exc).__name__}: {exc}",
            "diagnostics": diagnostics,
        }))
        sys.exit(0)


if __name__ == "__main__":
    main()
