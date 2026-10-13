import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  // Use swap so text is visible immediately instead of waiting for the
  // font to download — makes the site feel much more responsive.
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Reddit Subscriber Dashboard",
  description: "Live status monitor for the Reddit subscriber browser script.",
  keywords: ["Reddit", "subscriber", "dashboard", "Playwright"],
  authors: [{ name: "Reddit Subscriber" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

// ============================================================
// Viewport configuration — CRITICAL for mobile responsiveness.
// Without this, mobile browsers render at desktop width (~980px)
// and the user has to pinch-to-zoom, making the site feel broken.
//
// width=device-width: render at the device's actual width
// initialScale=1: don't zoom in/out on load
// maximumScale=1: prevent accidental zoom gestures (improves UX)
// userScalable=no: disable pinch-zoom (prevents layout jumps)
// viewportFit=cover: use the full screen on notched devices
// ============================================================
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#020817" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Default to dark mode — add the `dark` class on <html>.
  // suppressHydrationWarning on <html> to silence extension-injected
  // attributes (ProtonPass, LastPass, etc.) that would otherwise cause
  // hydration mismatches.
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
        suppressHydrationWarning
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
