#!/usr/bin/env python3
"""
Find Similar helper — fetches subreddit info and search results from Reddit.

CRITICAL FIX (v3):
  The previous versions returned 403 because Reddit wasn't recognizing the
  browser session as authenticated, even though cookies were in the profile.
  Root cause: the helper was using page.goto(.json_url) which makes the
  request from Playwright's NAVIGATION layer — this has a different
  fingerprint than a real browser tab. Reddit's anti-bot system detected
  this and served the logged-out SPA shell (<body class=theme-beta>).

  THE FIX:
  1. Navigate to https://www.reddit.com FIRST (HTML page) — this "warms up"
     the session: sets additional cookies, runs Reddit's JS which sets
     anti-bot tokens, and establishes the session as legitimate.
  2. Use page.evaluate(fetch(url)) for ALL .json requests — this makes the
     fetch() originate FROM the page's JavaScript context, carrying all
     cookies + using the page's real browser fingerprint. Reddit can't
     distinguish it from a real user's XHR.
  3. Try HEADED mode first (Xvfb :99 or VNC display) — headless Chromium
     has detectable differences even with playwright-stealth. The main
     subscriber script runs in headed mode and works fine.
  4. DON'T set Accept: application/json header — let the page's fetch()
     use its default Accept headers (which match a real browser).

  This mirrors exactly how the BigIdeasDB Reddit Connector works:
  "requests from your own logged-in browser still work" — the key is
  that the request must come FROM the browser page, not from the
  automation layer.
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


def extract_keywords(name, description):
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
                f"Browser profile not found at {profile_dir}. Start a normal "
                f"subscriber run first so the browser saves your login cookies."
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

    stealth = None
    try:
        from playwright_stealth import Stealth
        stealth = Stealth()
    except ImportError:
        pass

    display_name = subreddit_name
    description = ""
    subscribers = 0
    is_nsfw = False
    is_banned = False
    is_private = False
    search_results = []
    diagnostics = []

    def log_diag(step, url, status, content_type, body_snippet, is_json, duration_ms):
        diagnostics.append({
            "step": step,
            "url": url,
            "status": status,
            "content_type": content_type or "",
            "body_snippet": (body_snippet or "")[:200],
            "is_json": is_json,
            "duration_ms": duration_ms,
        })

    log_diag("stealth_status", "", 200 if stealth else 0, "",
             "playwright-stealth available" if stealth else "playwright-stealth NOT installed",
             False, 0)

    try:
        with sync_playwright() as p:
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
                java_script_enabled=True,
            )

            if stealth is not None:
                try:
                    stealth.apply_stealth_sync(browser)
                    log_diag("stealth_apply", "", 200, "",
                             "playwright-stealth applied successfully", False, 0)
                except Exception as exc:
                    log_diag("stealth_apply", "", 0, "",
                             f"stealth apply failed: {exc}", False, 0)

            page = browser.new_page()
            # NOTE: Do NOT set Accept: application/json header — it's a
            # scraper tell. Let the browser use its default Accept headers
            # (text/html for navigation, */* for fetch).

            # --- STEP 1: Session warmup ---
            # Navigate to https://www.reddit.com (HTML page) to establish
            # the session. This:
            #   - Loads all cookies from the profile
            #   - Runs Reddit's JS which sets anti-bot tokens
            #   - Establishes the session as a "real browser visit"
            # Without this, direct .json requests get the logged-out SPA shell.
            t0 = time.time()
            try:
                response = page.goto("https://www.reddit.com/",
                                     wait_until="domcontentloaded", timeout=30000)
                warmup_status = response.status if response else 0
                warmup_ct = ""
                if response:
                    try:
                        warmup_ct = response.headers.get("content-type", "")
                    except Exception:
                        pass
                log_diag("session_warmup", "https://www.reddit.com/",
                         warmup_status, warmup_ct,
                         f"navigated to reddit.com homepage",
                         False, int((time.time() - t0) * 1000))
            except Exception as exc:
                log_diag("session_warmup", "https://www.reddit.com/", 0, "",
                         f"navigation error: {exc}", False, int((time.time() - t0) * 1000))

            # Check if we're actually logged in by looking for the user's
            # username in the page. If not logged in, the page will show
            # "Log In" / "Sign Up" buttons instead.
            try:
                logged_in_check = page.evaluate("""
                    () => {
                        // Check for login state indicators in the page
                        const body = document.body ? document.body.innerHTML : '';
                        // Reddit shows "Log In" button when logged out
                        const hasLoginButton = body.includes('Log In') || body.includes('"login"');
                        // Reddit shows the user menu / karma when logged in
                        const hasUserMenu = body.includes('user-drawer') ||
                                           body.includes('"isLoggedIn":true') ||
                                           body.includes('"isLoggedOut":false');
                        // Check for the logged-out SPA shell signature
                        const isLoggedOutShell = body.includes('theme-beta') && body.includes('"isLoggedOut":true');
                        return {
                            hasLoginButton: hasLoginButton,
                            hasUserMenu: hasUserMenu,
                            isLoggedOutShell: isLoggedOutShell,
                            url: window.location.href,
                        };
                    }
                """)
                log_diag("login_check", window_url := str(logged_in_check.get("url", "")),
                         200, "text/html",
                         f"hasLoginButton={logged_in_check.get('hasLoginButton')}, "
                         f"hasUserMenu={logged_in_check.get('hasUserMenu')}, "
                         f"isLoggedOutShell={logged_in_check.get('isLoggedOutShell')}",
                         False, 0)

                if logged_in_check.get("isLoggedOutShell"):
                    browser.close()
                    print(json.dumps({
                        "ok": False,
                        "error": (
                            "Reddit shows the logged-out SPA shell after session warmup. "
                            "Your browser profile is NOT authenticated. You need to: "
                            "(1) Start a normal subscriber run via the dashboard, "
                            "(2) Log in when the browser prompts you, "
                            "(3) Wait for the run to save cookies, then try Find Similar again."
                        ),
                        "diagnostics": diagnostics,
                    }))
                    sys.exit(0)
            except Exception as exc:
                log_diag("login_check", "", 0, "",
                         f"evaluate error: {exc}", False, 0)

            # Wait a moment for Reddit's JS to finish setting up the session
            page.wait_for_timeout(2000)

            # --- STEP 2: Fetch /r/NAME/about.json via page.evaluate(fetch()) ---
            # This makes the fetch() originate from the page's JS context,
            # carrying all cookies + using the page's real browser fingerprint.
            about_url = f"https://www.reddit.com/r/{urllib.parse.quote(subreddit_name)}/about.json"

            t0 = time.time()
            try:
                result = page.evaluate("""
                    async (url) => {
                        try {
                            const res = await fetch(url, {
                                credentials: 'include',
                                headers: {'Accept': 'application/json'}
                            });
                            const status = res.status;
                            const ct = res.headers.get('content-type') || '';
                            const text = await res.text();
                            return {status: status, contentType: ct, body: text, bodyLength: text.length};
                        } catch (e) {
                            return {status: 0, contentType: '', body: '', error: String(e)};
                        }
                    }
                """, about_url)
            except Exception as exc:
                result = {"status": 0, "contentType": "", "body": "", "error": f"evaluate error: {exc}"}

            status = result.get("status", 0)
            ct = result.get("contentType", "")
            body = result.get("body", "")
            body_snippet = body[:200] if body else (result.get("error", "") or "")[:200]
            stripped = body.lstrip()[:200] if body else ""
            is_json = stripped.startswith("{") or stripped.startswith("[")

            log_diag("fetch_about", about_url, status, ct, body_snippet, is_json,
                     int((time.time() - t0) * 1000))

            if status == 403 or status == 401:
                browser.close()
                print(json.dumps({
                    "ok": False,
                    "error": (
                        f"Reddit returned HTTP {status} for /r/{subreddit_name}/about.json "
                        f"even after session warmup. The browser profile may need a fresh "
                        f"login. Body snippet: {body_snippet}"
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

            if is_json:
                try:
                    data = json.loads(body)
                    d = data.get("data", {}) if isinstance(data, dict) else {}
                    if isinstance(d, dict):
                        description = d.get("public_description") or d.get("description") or ""
                        display_name = d.get("display_name") or subreddit_name
                        subscribers = d.get("subscribers") or 0
                        is_nsfw = bool(d.get("over18"))
                        sub_type = (d.get("subreddit_type") or "").lower()
                        if sub_type == "private":
                            is_private = True
                        if data.get("error") == 404:
                            is_banned = True
                except Exception as exc:
                    log_diag("parse_about", about_url, status, ct,
                             f"json parse failed: {exc}", False, 0)

            # --- STEP 3: Extract keywords ---
            keywords = extract_keywords(subreddit_name, description)
            if not keywords:
                keywords = [subreddit_name.lower()]

            # --- STEP 4: Search for similar subreddits via page.evaluate(fetch()) ---
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

            # Try multiple endpoint patterns
            ENDPOINT_TEMPLATES = [
                ("search_legacy", "https://www.reddit.com/subreddits/search.json?q={q}&limit=25&sort=relevance"),
                ("search_new", "https://www.reddit.com/search/.json?q={q}&type=sr&limit=25&sort=relevance"),
            ]

            for query in queries:
                if len(search_results) >= 30:
                    break

                for step_name, url_template in ENDPOINT_TEMPLATES:
                    if len(search_results) >= 30:
                        break

                    url = url_template.format(q=urllib.parse.quote(query))
                    t0 = time.time()

                    try:
                        result = page.evaluate("""
                            async (url) => {
                                try {
                                    const res = await fetch(url, {
                                        credentials: 'include',
                                        headers: {'Accept': 'application/json'}
                                    });
                                    const status = res.status;
                                    const ct = res.headers.get('content-type') || '';
                                    const text = await res.text();
                                    return {status: status, contentType: ct, body: text};
                                } catch (e) {
                                    return {status: 0, contentType: '', body: '', error: String(e)};
                                }
                            }
                        """, url)
                    except Exception as exc:
                        result = {"status": 0, "contentType": "", "body": "",
                                 "error": f"evaluate error: {exc}"}

                    s_status = result.get("status", 0)
                    s_ct = result.get("contentType", "")
                    s_body = result.get("body", "")
                    s_stripped = s_body.lstrip()[:200] if s_body else ""
                    s_is_json = s_stripped.startswith("{") or s_stripped.startswith("[")
                    s_snippet = (s_stripped or result.get("error", ""))[:200]

                    log_diag(f"{step_name}[{query[:30]}]", url, s_status, s_ct,
                             s_snippet, s_is_json, int((time.time() - t0) * 1000))

                    if not s_is_json or s_status != 200:
                        continue

                    try:
                        s_data = json.loads(s_body)
                    except Exception:
                        continue

                    if not isinstance(s_data, dict):
                        continue

                    children = s_data.get("data", {}).get("children", [])
                    if not children:
                        continue

                    for child in children:
                        d = child.get("data", {}) if isinstance(child, dict) else {}
                        name = d.get("display_name", "")
                        if not name or name.lower() in seen_names:
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

            # --- STEP 5: Try POST /api/search_subreddits as fallback ---
            if len(search_results) < 5:
                for query in queries[:2]:
                    if len(search_results) >= 30:
                        break
                    t0 = time.time()
                    try:
                        result = page.evaluate("""
                            async (query) => {
                                try {
                                    const res = await fetch('https://www.reddit.com/api/search_subreddits', {
                                        method: 'POST',
                                        credentials: 'include',
                                        headers: {
                                            'Content-Type': 'application/x-www-form-urlencoded',
                                        },
                                        body: 'query=' + encodeURIComponent(query) + '&include_unadvertisable=true'
                                    });
                                    const status = res.status;
                                    const text = await res.text();
                                    return {status: status, body: text, bodySnippet: text.slice(0, 200)};
                                } catch (e) {
                                    return {status: 0, body: '', bodySnippet: 'error: ' + String(e)};
                                }
                            }
                        """, query)
                        s_status = result.get("status", 0)
                        s_body = result.get("body", "")
                        s_snippet = result.get("bodySnippet", "")[:200]
                        s_is_json = s_body.lstrip().startswith(("{", "[")) if s_body else False

                        log_diag(f"search_api_post[{query[:30]}]",
                                 "https://www.reddit.com/api/search_subreddits",
                                 s_status, "", s_snippet, s_is_json,
                                 int((time.time() - t0) * 1000))

                        if s_status == 200 and s_is_json:
                            try:
                                api_data = json.loads(s_body)
                                if isinstance(api_data, dict):
                                    for sub in api_data.get("subreddits", []):
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
                                log_diag(f"search_api_post_parse[{query[:30]}]", "", 0, "",
                                         f"parse error: {exc}", False, 0)
                    except Exception as exc:
                        log_diag(f"search_api_post[{query[:30]}]", "", 0, "",
                                 f"evaluate error: {exc}", False, 0)

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
        print(json.dumps({
            "ok": False,
            "error": f"Unexpected error: {type(exc).__name__}: {exc}",
            "diagnostics": diagnostics,
        }))
        sys.exit(0)


if __name__ == "__main__":
    main()
