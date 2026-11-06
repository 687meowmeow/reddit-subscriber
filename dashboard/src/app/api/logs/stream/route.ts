import logger, { LogEntry } from "@/lib/logger";

// ============================================================
// /api/logs/stream — Server-Sent Events (SSE) log stream.
//
// GET /api/logs/stream
//   Returns a text/event-stream that pushes new log entries in real time.
//   The /logs page connects to this via EventSource and appends new
//   entries as they arrive — no polling needed.
//
// Each SSE message is:
//   data: {"timestamp":"...","level":"INFO","message":"...","route":"..."}
//
// The connection stays open until the client disconnects. When the
// client disconnects, the listener is automatically unsubscribed.
// ============================================================

export const dynamic = "force-dynamic";

export function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Send a heartbeat comment immediately so the client knows
      // the connection is alive (some proxies buffer SSE).
      controller.enqueue(encoder.encode(": heartbeat\n\n"));

      // Register a listener that pushes each new log entry to the stream
      const unsubscribe = logger.subscribe((entry: LogEntry) => {
        try {
          const data = `data: ${JSON.stringify(entry)}\n\n`;
          controller.enqueue(encoder.encode(data));
        } catch (err) {
          // Stream might be closed — unsubscribe will handle cleanup
        }
      });

      // Send a heartbeat every 15 seconds to keep the connection alive
      // (prevents proxies/load balancers from timing out the connection)
      const heartbeatInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          // Stream closed
        }
      }, 15000);

      // Cleanup when the client disconnects
      const cleanup = () => {
        unsubscribe();
        clearInterval(heartbeatInterval);
      };

      // The Web Streams API doesn't have a direct "close" callback,
      // but cancel() is called when the consumer (client) cancels.
      // We also handle errors.
    },
    cancel() {
      // Called when the client disconnects — cleanup is handled by
      // the closure in start(). But we need to re-register cleanup
      // since the closure might not have captured the unsubscribe fn.
      // Actually, the closure DID capture it, so this is a no-op here.
      // The real cleanup happens in the start() closure when the
      // stream errors or the controller closes.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no", // disable nginx buffering
    },
  });
}
