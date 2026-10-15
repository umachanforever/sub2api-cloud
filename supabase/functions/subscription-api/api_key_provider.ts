import { mappedCatalog, type ModelSources } from "./model_mapping.ts";
import { filterModelCatalog, type ModelAllowlist } from "./model_policy.ts";
import type { ApiKeyCredentials, Platform } from "./gateway.ts";
import { HttpError } from "./db.ts";
import { parseAccountCredentials } from "./validation.ts";
import { hasGeneratedToken, trackedStream, type Usage } from "./stream.ts";
import { json } from "./http.ts";

type Item = Record<string, any>;
export type NativeProtocol =
  | "chat"
  | "responses"
  | "messages"
  | "gemini"
  | "models";
const origins: Record<Platform, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  antigravity: "https://cloudcode-pa.googleapis.com",
};

export function apiKeyRequest(
  platform: Platform,
  credentials: ApiKeyCredentials,
  protocol: NativeProtocol,
  path: string,
  body: Item | undefined,
  request: Request,
  signal: AbortSignal,
): { url: string; init: RequestInit; streaming: boolean } {
  if (platform === 'antigravity') throw new HttpError(501, 'provider_requires_oauth');
  // Revalidate decrypted routing data; never send a secret to a custom URL or redirect.
  const validated = parseAccountCredentials(
    credentials,
    platform,
    "apikey",
  ) as ApiKeyCredentials;
  if (
    (platform === "openai" &&
      !["chat", "responses", "models"].includes(protocol)) ||
    (platform === "anthropic" && !["messages", "models"].includes(protocol)) ||
    (platform === "gemini" && !["gemini", "models"].includes(protocol)) ||
    (path.startsWith("/v1beta/models") && protocol === "models" &&
      platform !== "gemini")
  ) throw new HttpError(501, "provider_protocol_unsupported");
  if (
    protocol === "models" &&
    new URL(request.url).searchParams.has("client_version")
  ) throw new HttpError(501, "codex_manifest_requires_oauth");
  const streaming = protocol === "gemini"
    ? path.endsWith(":streamGenerateContent")
    : body?.stream === true;
  const headers = new Headers({
    "content-type": "application/json",
    accept: streaming ? "text/event-stream" : "application/json",
  });
  let providerPath = path;
  if (platform === "openai") {
    headers.set("authorization", `Bearer ${validated.api_key}`);
    if (protocol === "responses") providerPath = "/v1/responses";
  } else if (platform === "anthropic") {
    headers.set("x-api-key", validated.api_key);
    const version = request.headers.get("anthropic-version") ?? "2023-06-01";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(version)) {
      throw new HttpError(400, "invalid_anthropic_version");
    }
    headers.set("anthropic-version", version);
    const beta = request.headers.get("anthropic-beta");
    if (beta) {
      if (beta.length > 1000 || !/^[a-zA-Z0-9,._-]+$/.test(beta)) {
        throw new HttpError(400, "invalid_anthropic_beta");
      }
      headers.set("anthropic-beta", beta);
    }
  } else {
    headers.set("x-goog-api-key", validated.api_key);
  }
  const query = new URLSearchParams();
  if (protocol === "models") {
    const modelId = /\/models\/([^/]+)$/.exec(path)?.[1];
    providerPath = `${platform === "gemini" ? "/v1beta" : "/v1"}/models${
      modelId ? `/${encodeURIComponent(decodeURIComponent(modelId))}` : ""
    }`;
    const incoming = new URL(request.url).searchParams;
    const allowed = platform === "anthropic"
      ? ["before_id", "after_id", "limit"]
      : platform === "gemini"
      ? ["pageSize", "pageToken"]
      : [];
    for (const key of allowed) {
      const value = incoming.get(key);
      if (value === null) continue;
      if (
        modelId || incoming.getAll(key).length !== 1 || !value ||
        value.length > 2000 ||
        ((key === "limit" || key === "pageSize") &&
          (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1000))
      ) throw new HttpError(400, "invalid_model_pagination");
      query.set(key, value);
    }
  } else if (platform === "gemini" && streaming) query.set("alt", "sse");
  const outbound = body ? structuredClone(body) : undefined;
  return {
    url: origins[platform] + providerPath +
      (query.size ? `?${query}` : ""),
    init: {
      method: body ? "POST" : "GET",
      headers,
      signal,
      redirect: "error",
      ...(outbound ? { body: JSON.stringify(outbound) } : {}),
    },
    streaming,
  };
}

function modelCatalog(platform: Platform, path: string, value: Item): Item {
  const single = /\/models\/[^/]+$/.test(path);
  if (platform === "gemini" || platform === "antigravity") {
    const entries = single ? [value] : value.models;
    if (
      !Array.isArray(entries) ||
      entries.some((entry: Item) =>
        typeof entry?.name !== "string" ||
        !/^models\/[a-zA-Z0-9._-]+$/.test(entry.name)
      )
    ) {
      throw new HttpError(502, "invalid_upstream_model_catalog");
    }
    if (path.startsWith("/v1beta/")) return value;
    const data = entries.map((entry: Item) => ({
      ...entry,
      id: entry.name.slice(7),
      object: "model",
      created: 0,
      owned_by: "google",
    }));
    return single ? data[0] : {
      object: "list",
      data,
      ...(value.nextPageToken ? { nextPageToken: value.nextPageToken } : {}),
    };
  }
  const entries = single ? [value] : value.data;
  if (
    !Array.isArray(entries) ||
    entries.some((entry: Item) => typeof entry?.id !== "string" || !entry.id)
  ) {
    throw new HttpError(502, "invalid_upstream_model_catalog");
  }
  return value;
}

function tokens(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : null;
}

export function nativeUsage(
  platform: Platform,
  protocol: NativeProtocol,
  value: Item,
  prior: Usage = {
    input: null,
    output: null,
    cacheCreation: null,
    cacheRead: null,
    outcome: "incomplete",
  },
): Usage {
  const usage = { ...prior };
  if (platform === "openai") {
    const totals = protocol === "responses"
      ? (value.response?.usage ?? value.usage)
      : value.usage;
    const input = tokens(
      protocol === "responses" ? totals?.input_tokens : totals?.prompt_tokens,
    );
    const output = tokens(
      protocol === "responses"
        ? totals?.output_tokens
        : totals?.completion_tokens,
    );
    const cacheRead = tokens(
      protocol === "responses"
        ? totals?.input_tokens_details?.cached_tokens
        : totals?.prompt_tokens_details?.cached_tokens,
    );
    if (input !== null) usage.input = input;
    if (output !== null) usage.output = output;
    if (cacheRead !== null) usage.cacheRead = cacheRead;
    if (value.type === "response.failed" || value.error) {
      usage.outcome = "failed";
    } else if (
      value.type === "response.incomplete" || value.status === "incomplete"
    ) usage.outcome = "incomplete";
    else if (
      value.type === "response.completed" || value.status === "completed"
    ) usage.outcome = "completed";
    else if (
      protocol === "chat" &&
      value.choices?.some((choice: Item) => choice.finish_reason)
    ) {
      usage.outcome = value.choices.some((choice: Item) =>
          ["length", "content_filter"].includes(choice.finish_reason)
        )
        ? "incomplete"
        : "completed";
    }
  } else if (platform === "anthropic" || platform === "antigravity" && protocol === "messages") {
    const totals = value.message?.usage ?? value.usage;
    const input = tokens(totals?.input_tokens),
      output = tokens(totals?.output_tokens);
    const cacheRead = tokens(totals?.cache_read_input_tokens),
      cacheCreation = tokens(totals?.cache_creation_input_tokens);
    if (input !== null) {
      usage.input = tokens(
        input + (tokens(totals?.cache_read_input_tokens) ?? 0) +
          (tokens(totals?.cache_creation_input_tokens) ?? 0),
      );
    }
    if (output !== null) usage.output = output;
    if (cacheRead !== null) usage.cacheRead = cacheRead;
    if (cacheCreation !== null) usage.cacheCreation = cacheCreation;
    if (value.type === "error" || value.error) usage.outcome = "failed";
    else if (
      ["max_tokens", "refusal"].includes(
        value.delta?.stop_reason ?? value.stop_reason,
      )
    ) usage.outcome = "incomplete";
    else if (
      value.type === "message_stop" || value.delta?.stop_reason ||
      value.stop_reason
    ) {
      if (usage.outcome !== "incomplete" || value.type !== "message_stop") {
        usage.outcome = "completed";
      }
    }
  } else {
    const totals = value.usageMetadata;
    const input = tokens(totals?.promptTokenCount),
      output = tokens(totals?.candidatesTokenCount),
      cacheRead = tokens(totals?.cachedContentTokenCount);
    if (input !== null) usage.input = input;
    if (output !== null) {
      usage.output = tokens(output + (tokens(totals?.thoughtsTokenCount) ?? 0));
    }
    if (cacheRead !== null) usage.cacheRead = cacheRead;
    if (value.error) usage.outcome = "failed";
    else if (value.promptFeedback?.blockReason) usage.outcome = "incomplete";
    else if (
      value.candidates?.some((candidate: Item) => candidate.finishReason)
    ) {
      usage.outcome = value.candidates.every((candidate: Item) =>
          candidate.finishReason === "STOP"
        )
        ? "completed"
        : "incomplete";
    }
  }
  return usage;
}

class NativeUsageObserver {
  usage: Usage = {
    input: null,
    output: null,
    cacheCreation: null,
    cacheRead: null,
    outcome: "incomplete",
  };
  private decoder = new TextDecoder();
  private pending = "";
  private platform: Platform;
  private protocol: NativeProtocol;
  private started: number;
  constructor(platform: Platform, protocol: NativeProtocol, started: number) {
    this.platform = platform;
    this.protocol = protocol;
    this.started = started;
  }
  push(bytes: Uint8Array) {
    this.consume(this.decoder.decode(bytes, { stream: true }));
  }
  end() {
    this.consume(this.decoder.decode() + "\n\n");
  }
  private consume(text: string) {
    this.pending += text;
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(this.pending))) {
      const frame = this.pending.slice(0, boundary.index);
      this.pending = this.pending.slice(boundary.index + boundary[0].length);
      if (frame.length > 1_048_576) throw new Error("upstream_event_too_large");
      const data = frame.split(/\r?\n/).filter((line) =>
        line.startsWith("data:")
      ).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      if (data === "[DONE]") continue;
      const value = JSON.parse(data);
      this.usage = nativeUsage(this.platform, this.protocol, value, this.usage);
      if (this.usage.firstTokenMs === undefined && hasGeneratedToken(value)) this.usage.firstTokenMs = Math.max(0, Math.min(2147483647, Date.now() - this.started));
      if (this.usage.outcome === "failed") {
        throw new Error("upstream_stream_failed");
      }
    }
    if (this.pending.length > 1_048_576) {
      throw new Error("upstream_event_too_large");
    }
  }
}

// Buffer complete frames before forwarding, so an upstream SSE error cannot leak in partial chunks.
function nativeFrames(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  let pending = "";
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        pending += decoder.decode(bytes, { stream: true });
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(pending))) {
          const length = boundary.index + boundary[0].length;
          if (length > 1_048_576) throw new Error("upstream_event_too_large");
          controller.enqueue(encoder.encode(pending.slice(0, length)));
          pending = pending.slice(length);
        }
        if (pending.length > 1_048_576) {
          throw new Error("upstream_event_too_large");
        }
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending.trim()) {
          controller.enqueue(encoder.encode(pending + "\n\n"));
        }
      },
    }),
  );
}

export async function nativeResponse(
  upstream: Response,
  platform: Platform,
  protocol: NativeProtocol,
  streaming: boolean,
  signal: AbortSignal,
  requestId: string,
  finish: (status: number, usage: Usage) => Promise<void>,
  path = "",
  allowlist?:ModelAllowlist,
  modelSources?:ModelSources,
  aliasModel?:string,
  started = Date.now(),
): Promise<Response> {
  if (!upstream.body) throw new HttpError(502, "invalid_upstream_response");
  if (!streaming) {
    let value = await upstream.json();
    if (
      !value || typeof value !== "object" || Array.isArray(value) ||
      value.error || (protocol === "chat" && !Array.isArray(value.choices)) ||
      (protocol === "messages" && value.type !== "message") ||
      (protocol === "responses" && value.object !== "response") ||
      (protocol === "gemini" && !Array.isArray(value.candidates) &&
        !value.promptFeedback)
    ) throw new HttpError(502, "invalid_upstream_response");
    if (protocol === "models") {
      value = filterModelCatalog(allowlist,mappedCatalog(modelCatalog(platform, path, value),modelSources,platform),/\/models\/[^/]+$/.test(path));
      if(aliasModel) {const entries=value.data??value.models;value=entries.find((entry:Item)=>(entry.id??entry.name?.replace(/^models\//,''))===aliasModel);if(!value)throw new HttpError(404,"model_not_found");}
    }
    const usage = protocol === "models"
      ? {
        input: null,
        output: null,
        cacheCreation: null,
        cacheRead: null,
        outcome: "completed" as const,
      }
      : nativeUsage(platform, protocol, value, {
        input: null,
        output: null,
        cacheCreation: null,
        cacheRead: null,
        outcome: "completed",
      });
    await finish(upstream.status, usage);
    return json(upstream.status, value);
  }
  const contentType = upstream.headers.get("content-type");
  if (contentType && !contentType.includes("text/event-stream")) {
    await upstream.body.cancel();
    throw new HttpError(502, "invalid_upstream_stream");
  }
  return new Response(
    trackedStream(
      nativeFrames(upstream.body),
      signal,
      (usage) => finish(upstream.status, usage),
      new NativeUsageObserver(platform, protocol, started),
    ),
    {
      status: upstream.status,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-request-id": requestId,
      },
    },
  );
}
