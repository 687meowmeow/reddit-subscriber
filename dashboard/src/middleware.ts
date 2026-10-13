import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// ============================================================
// Middleware — runs on every request.
//
// 1. Adds permissive CORS headers so the dashboard can be
//    accessed from ANY device on the network (phone, laptop,
//    tablet, TV, whatever) regardless of IP or hostname.
//
// 2. Handles CORS preflight (OPTIONS) requests.
//
// 3. Sets X-Forwarded-Host to the incoming Host header so
//    Next.js's dev server doesn't reject requests from
//    non-localhost origins.
// ============================================================

export function middleware(request: NextRequest) {
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

// Run on all routes (including API and static assets)
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
