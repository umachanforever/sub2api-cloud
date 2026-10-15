import { Database, HttpError } from "./db.ts";

export type ErrorContext = {
  requestId: string; started: number; keyHash?: string; leaseId?: string; accountId?: string;
  model?: string; upstreamModel?: string; platform?: string; stream?: boolean; endpoint?: string;
};
export function errorClassification(code: string, status: number, provider = false) {
  if (provider) return { phase: status === 401 ? "account_auth" : "upstream", type: "upstream_error", owner: "provider", source: "upstream_http", code: status === 401 ? "upstream_authentication_failed" : "upstream_request_failed", limited: false };
  if (["unauthorized", "invalid_api_key", "conflicting_credentials"].includes(code)) return { phase: "auth", type: "authentication_error", owner: "client", source: "client_request", code: "authentication_failed", limited: true };
  if (code === "insufficient_balance") return { phase: "request", type: "billing_error", owner: "client", source: "client_request", code, limited: true };
  if (/^(?:rate_limit_exceeded|group_rate_limit_exceeded|api_key_rate_(?:5h|1d|7d)_exceeded|concurrency_limit_exceeded|user_concurrency_exceeded)$/.test(code)) return { phase: "request", type: "rate_limit_error", owner: "client", source: "client_request", code: "request_limit_exceeded", limited: true };
  if (/(?:insufficient_balance|quota_exceeded|budget_exceeded|subscription_expired)/.test(code)) return { phase: "request", type: "billing_error", owner: "client", source: "client_request", code: "billing_limit_exceeded", limited: true };
  if (["no_available_account", "account_unavailable"].includes(code)) return { phase: "routing", type: "service_unavailable", owner: "platform", source: "gateway", code: "no_available_account", limited: false };
  if (code === "context_canceled") return { phase: "request", type: "context_canceled", owner: "client", source: "client_request", code, limited: true };
  if (["upstream_timeout", "upstream_unavailable"].includes(code)) return { phase: "network", type: "network_error", owner: "provider", source: "gateway", code, limited: false };
  if (["upstream_rejected_request", "invalid_upstream_stream", "invalid_upstream_response", "stream_incomplete"].includes(code)) return { phase: "upstream", type: "upstream_error", owner: "provider", source: "gateway", code: "upstream_response_failed", limited: false };
  return { phase: status < 500 ? "request" : "internal", type: status < 500 ? "invalid_request_error" : "internal_error", owner: status < 500 ? "client" : "platform", source: status < 500 ? "client_request" : "gateway", code: status < 500 ? "invalid_request" : "gateway_error", limited: false };
}
export async function recordOpsError(db: Database, context: ErrorContext, status: number, code: string,
  kind: "request" | "upstream" = "request", eventId = context.requestId) {
  try {
    await db.rpc(db.config.dataModel === "native" ? "s2a_personal_ops_error_record" : "s2a_ops_error_record", { p_event: {
      ...errorClassification(code, status, kind === "upstream" && code === "upstream_http"),
      event_id: eventId, request_id: context.requestId, kind, status_code: status,
      key_hash: context.keyHash, lease_id: context.leaseId, account_id: context.accountId, model: context.model ?? "",
      upstream_model: context.upstreamModel ?? "", platform: context.platform ?? "",
      stream: context.stream ?? null, endpoint: context.endpoint ?? "",
      duration_ms: Math.max(0, Math.min(2147483647, Date.now() - context.started)),
    } });
  } catch { console.error("ops_error_persistence_failed"); }
}
