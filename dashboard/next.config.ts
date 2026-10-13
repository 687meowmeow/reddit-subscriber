import type { NextConfig } from "next";

// ============================================================
// Generate a broad list of private IP addresses so the dashboard
// can be accessed from any device on any common home/office network.
//
// Next.js 16's `allowedDevOrigins` does NOT accept wildcards or
// subnets — only exact hostnames or IP addresses. So we generate
// the full list of common private IPs here.
//
// Covers:
//   - 192.168.0.1 - 192.168.1.254  (most home routers)
//   - 10.0.0.1 - 10.0.0.254        (some corporate networks)
//   - 172.16.0.1 - 172.16.0.254    (Docker default)
//
// Also includes localhost variants and common mDNS names.
// ============================================================

function generatePrivateIps(): string[] {
  const ips: string[] = [];
  // 192.168.0.x and 192.168.1.x — covers 99% of home networks
  for (let sub = 0; sub <= 1; sub++) {
    for (let host = 1; host <= 254; host++) {
      ips.push(`192.168.${sub}.${host}`);
    }
  }
  // 10.0.0.x — common corporate / mesh network range
  for (let host = 1; host <= 254; host++) {
    ips.push(`10.0.0.${host}`);
  }
  // 172.16.0.x — Docker / WSL default
  for (let host = 1; host <= 254; host++) {
    ips.push(`172.16.0.${host}`);
  }
  return ips;
}

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,

  // ============================================================
  // ALLOW ALL PRIVATE IPs — top level (NOT under experimental).
  //
  // This lets you access the dashboard from any device on your
  // local network: phone, laptop, tablet, another Pi, etc.
  //
  // The list is generated programmatically above to cover the
  // three common private IP ranges.
  //
  // If your network uses a non-standard range (e.g. 10.0.1.x),
  // just add it to the array below.
  // ============================================================
  allowedDevOrigins: [
    // localhost variants
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    // mDNS / Bonjour names (common on Raspberry Pi)
    "raspberrypi.local",
    "raspberrypi",
    "pi.local",
    "reddit-pi.local",
    // all generated private IPs (192.168.x.x, 10.0.0.x, 172.16.0.x)
    ...generatePrivateIps(),
  ],
};

export default nextConfig;
