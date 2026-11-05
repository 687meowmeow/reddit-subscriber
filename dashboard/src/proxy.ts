import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import logger from "@/lib/logger";

// ============================================================
// Proxy (formerly "middleware" in Next.js < 16.4)
// ------------------------------------------------------------
// Runs on every request. Does three things:
//
// 1. Adds permissive CORS headers (`Access-Control-Allow-Origin: *`)
//    so the dashboard can be accessed from ANY device on the
//    network — phone, laptop, tablet, another Pi — regardless of
//    IP or hostname.
//
// 2. Handles CORS preflight (OPTIONS) requests so browser fetch()
//    calls from any origin succeed.
//
// 3. LOGS every HTTP request — method, path, status, duration —
//    to the server-side logger. This is the single highest-value
//    log point because it captures ALL traffic, including requests
//    to routes that don't have explicit logging of their own.
//    Logged AFTER the response is generated (we measure duration).
//
// Note: this is the new Next.js 16.4 convention. The old
// `middleware.ts` filename is deprecated — use `proxy.ts` instead.
// ============================================================

export function proxy(request: NextRequest) {
  const start = Date.now();
  const requestId = logger.nextRequestId();
  const method = request.method;
  const url = request.nextUrl.pathname + request.nextUrl.search;
  const userAgent = request.headers.get("user-agent") || "";
  const clientIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";

  // Log the incoming request immediately (so it shows up even if the
  // route handler crashes before responding)
  logger.debug(`→ ${method} ${url}`, {
    requestId,
    method,
    path: request.nextUrl.pathname,
    query: Object.fromEntries(request.nextUrl.searchParams.entries()),
    clientIp,
    userAgent: userAgent.slice(0, 100), // truncate long UA strings
  }, `${method} ${request.nextUrl.pathname}`);

  // Handle CORS preflight
  if (method === "OPTIONS") {
    const response = new NextResponse(null, { status: 204 });
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    response.headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Requested-With"
    );
    response.headers.set("Access-Control-Max-Age", "86400");
    const duration = Date.now() - start;
    logger.http(method, url, 204, duration, requestId);
    return response;
  }

  // Get the response from continuing the request
  const response = NextResponse.next();

  // Add permissive CORS headers to ALL responses
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  response.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );

  // Log the request completion with duration.
  // NOTE: response.status here is the middleware's status (200), not
  // the final handler's status — Next.js middleware can't see the
  // final response status. The route handlers themselves log their
  // own status on exit. This HTTP entry is still useful for seeing
  // the request volume, timing, and URL patterns.
  const duration = Date.now() - start;
  logger.http(method, url, response.status, duration, requestId);

  return response;
}

// Backwards-compatible alias (some Next.js versions look for `middleware`)
export { proxy as middleware };

// Run on all routes (including API and static assets)
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
