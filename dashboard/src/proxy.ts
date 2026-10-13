import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// ============================================================
// Proxy (formerly "middleware" in Next.js < 16.4)
// ------------------------------------------------------------
// Runs on every request. Does two things:
//
// 1. Adds permissive CORS headers (`Access-Control-Allow-Origin: *`)
//    so the dashboard can be accessed from ANY device on the
//    network — phone, laptop, tablet, another Pi — regardless of
//    IP or hostname.
//
// 2. Handles CORS preflight (OPTIONS) requests so browser fetch()
//    calls from any origin succeed.
//
// Note: this is the new Next.js 16.4 convention. The old
// `middleware.ts` filename is deprecated — use `proxy.ts` instead.
// The export is still named `middleware` for backwards compat,
// but Next.js 16.4 also accepts `proxy` as the export name.
// ============================================================

export function proxy(request: NextRequest) {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    const response = new NextResponse(null, { status: 204 });
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    response.headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Requested-With"
    );
    response.headers.set("Access-Control-Max-Age", "86400");
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

  return response;
}

// Backwards-compatible alias (some Next.js versions look for `middleware`)
export { proxy as middleware };

// Run on all routes (including API and static assets)
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
