// ============================================================
// Instrumentation hook — runs once when the Next.js server starts.
// Used to log server startup so the first entry in /logs is always
// the server boot.
// ============================================================

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { default: logger } = await import("@/lib/logger");
    const os = await import("os");

    logger.info("Dashboard server starting", {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      cpu_count: os.cpus().length,
      total_memory_mb: Math.round(os.totalmem() / 1024 / 1024),
      free_memory_mb: Math.round(os.freemem() / 1024 / 1024),
      cwd: process.cwd(),
      env: process.env.NODE_ENV || "development",
      port: process.env.PORT || "3100",
    }, "instrumentation.register()");

    // Log process-level uncaught error handlers so unexpected crashes
    // show up in the log file (and thus in /logs) before the process dies.
    process.on("uncaughtException", (err) => {
      logger.error("UNCAUGHT EXCEPTION — process will crash", {
        error: err.message,
        name: err.name,
      }, "process.uncaughtException", err.stack);
    });

    process.on("unhandledRejection", (reason) => {
      logger.error("UNHANDLED PROMISE REJECTION", {
        reason: reason instanceof Error ? reason.message : String(reason),
        name: reason instanceof Error ? reason.name : typeof reason,
      }, "process.unhandledRejection",
        reason instanceof Error ? reason.stack : undefined);
    });

    logger.info("Process error handlers registered", undefined, "instrumentation.register()");
  }
}
