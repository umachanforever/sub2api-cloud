import { codexJobs } from './codex_jobs.ts';
import { type Config, Database, HttpError } from "./db.ts";
import { json } from "./http.ts";
import { proxy } from "./proxy.ts";
import { recordOpsError, type ErrorContext } from "./ops_errors.ts";
import { recordResponse } from "./ops_logs.ts";
import { mailJobs } from "./ops_mail.ts";
import { type SMTPTransport } from "./smtp.ts";
import { privacyJobs } from "./privacy_jobs.ts";
import { autoResetJobs } from "./openai_auto_reset.ts";
import { usageAccess } from "./usage_access.ts";

export function createHandler(config: Config, fetchImpl: typeof fetch = fetch, smtp?: SMTPTransport) {
  const db = new Database(config, fetchImpl);
  return async (request: Request): Promise<Response> => {
    const started = Date.now(), requestId = crypto.randomUUID();
    const errorContext: ErrorContext = { requestId, started };
    let errorCode = "gateway_error", gatewayRequest = false;
    let userId: string | undefined, unhandled = false, stack: string | undefined;
    const dispatch = async (): Promise<Response> => {
    try {
      let pathname = new URL(request.url).pathname.replace(
        /^(?:\/functions\/v1)?\/sub2api(?=\/|$)/,
        "",
      ) || "/";
      if (/^\/(?:models(?:\/[^/]+)?|chat\/completions|embeddings|images\/generations)$/.test(pathname)) {
        pathname = "/v1" + pathname;
      }
      const antigravityRoute = /^\/antigravity\/v1(?:beta)?\//.test(pathname);
      if (antigravityRoute) pathname = pathname.slice("/antigravity".length);
      gatewayRequest = /^\/v1(?:beta)?(?:\/|$)/.test(pathname) || ["/responses", "/backend-api/codex/responses", "/responses/input_tokens", "/backend-api/codex/responses/input_tokens"].includes(pathname);
      if (gatewayRequest) errorContext.endpoint = ["/responses", "/backend-api/codex/responses", "/responses/input_tokens", "/backend-api/codex/responses/input_tokens"].includes(pathname) ? pathname : /^\/v1\/(?:responses(?:\/input_tokens)?|messages|embeddings|images\/generations|chat\/completions|models)$/.test(pathname) ? pathname : pathname.startsWith("/v1beta/") ? "/v1beta/models/:model" : "/v1/unknown";
      if (pathname === "/internal/jobs/codex") return await codexJobs(request,db);
      if (pathname === "/internal/jobs/mail") return await mailJobs(request,db,smtp);
      if (pathname === "/internal/jobs/privacy") return await privacyJobs(request,db);
      if (pathname === "/internal/jobs/quota-reset") return await autoResetJobs(request,db);
      if (pathname === "/health" && request.method === "GET") {
        return json(200, { ok: true, version: "0.3.0", scope: "subscription-gateway" });
      }
      if (!gatewayRequest) throw new HttpError(404, "not_found");
      const authorization = request.headers.get("authorization");
      const bearer = authorization?.match(
        /^Bearer\s+(\S+)$/i,
      )?.[1];
      if (authorization !== null && !bearer) throw new HttpError(401, "unauthorized");
      const nativeKeys = pathname === "/v1/messages" || /^\/v1\/models(?:\/[^/]+)?$/.test(pathname)
        ? [request.headers.get("x-api-key")]
        : pathname.startsWith("/v1beta/")
        ? [request.headers.get("x-goog-api-key"), new URL(request.url).searchParams.get("key")]
        : [];

      const usageLinkKey = pathname === "/v1/usage" && request.method === "GET" ? new URL(request.url).searchParams.get("key") : null;
      if (usageLinkKey !== null && !/^sk-usage-[a-f0-9]{64}$/.test(usageLinkKey)) throw new HttpError(401, "unauthorized");
      const supplied = [bearer, usageLinkKey, ...nativeKeys].filter((value): value is string => !!value);
      if (new Set(supplied).size > 1) throw new HttpError(400, "conflicting_credentials");
      const token = supplied[0];
      if (!token) throw new HttpError(401, "unauthorized");
      if (pathname === "/v1/usage" && request.method === "GET") return await usageAccess(request, token, db);
      return await proxy(request, pathname, token, db, errorContext, antigravityRoute ? "antigravity" : undefined);
    } catch (error) {
      if (error instanceof HttpError) {
        errorCode = error.code;
        return json(error.status, {
          error: { type: error.code, message: error.message },
          ...(request.headers.get("x-s2a-frontend") === "1"
            ? { code: error.status, message: error.message }
            : {}),
        });
      }
      unhandled = true;
      stack = error instanceof Error ? error.stack : undefined;
      console.error(
        "subscription_api_error",
        error instanceof Error ? error.name : "unknown",
      );
      return json(500, {
        error: { type: "internal_error", message: "internal_error" },
      });
    }
    };
    const response = await dispatch();
    const logging = Promise.all([recordResponse(db, request, response, started, requestId, userId, unhandled, stack),
      gatewayRequest && response.status >= 400 ? recordOpsError(db, errorContext, response.status, request.signal.aborted ? "context_canceled" : errorCode) : Promise.resolve()]);
    const runtime = (globalThis as typeof globalThis & { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } }).EdgeRuntime;
    if (runtime) runtime.waitUntil(logging); else await logging;
    return response;
  };
}
