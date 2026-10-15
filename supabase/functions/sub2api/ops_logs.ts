import { Database } from "./db.ts";

// Only static event metadata reaches the sink; credentials, paths and exception text never do.
export async function recordResponse(db: Database, request: Request, response: Response, started: number,
  requestId: string, userId?: string, unhandled = false, stack?: string) {
  try {
    const frames = stack?.split("\n").slice(1).flatMap(line => {
      const name = line.match(/^\s*at (?:async )?([\w.]+) /)?.[1];
      return name && ["dispatch", "proxy", "Database.rest", "Database.rpc"].includes(name) ? [name] : [];
    }).slice(0, 8);
    await db.rpc("s2a_log_write", { p_event: {
      level: response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "info",
      message: unhandled ? "unhandled_error" : response.status >= 400 ? "request_failed" : "response_started",
      component: "edge", host: "supabase-edge", request_id: requestId, user_id: userId,
      extra: { status_code: response.status, method: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(request.method) ? request.method : "OTHER",
        response_started_ms: Math.max(0, Date.now() - started), caller: "app.dispatch", ...(frames?.length ? { stacktrace: frames } : {}) },
    } });
  } catch { console.error("system_log_persistence_failed"); }
}
