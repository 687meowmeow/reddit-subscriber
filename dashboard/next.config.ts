import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,

  // ============================================================
  // ALLOW ALL IPs / HOSTS for dev server access
  // ------------------------------------------------------------
  // Next.js 16's `allowedDevOrigins` does NOT accept wildcards,
  // so the proper way to "allow all IPs" is to disable the
  // dev-mode origin check entirely with `skipDevOriginCheck`
  // under `experimental`.
  //
  // This lets you access the dashboard from any device on your
  // network (phone, laptop, tablet) at any IP or hostname,
  // without needing to list them here.
  //
  // The src/middleware.ts file also adds `Access-Control-Allow-Origin: *`
  // so browser fetch() calls from any origin succeed.
  // ============================================================
  allowedDevOrigins: ["*"],
  experimental: {
    // Bypass the dev-mode origin protection entirely
    // (the strict check is what was breaking buttons on remote devices)
    skipDevOriginCheck: true,
    // Allow any origin to use the HMR websocket
    allowedDevOrigins: ["*"],
  } as any,
};

export default nextConfig;
