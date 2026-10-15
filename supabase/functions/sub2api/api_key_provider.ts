import {systemOneTokens} from './typesafe.ts';
import {grokImageBody} from './grok_images.ts';
import { normalizeModernCodexResponses } from "./codex_models.ts";
import { grokHeaders } from './grok_config.ts';
import { mappedCatalog, type ModelSources } from "./model_mapping.ts";
import { filterModelCatalog, type ModelAllowlist } from "./model_policy.ts";
import type { ApiKeyCredentials, Platform } from "./gateway.ts";
import { HttpError } from "./db.ts";
import { parseAccountCredentials } from "./validation.ts";
import { hasGeneratedToken, trackedStream, type Usage } from "./stream.ts";
import { json } from "./http.ts";

type Item = Record<string, any>;
export type NativeProtocol =
  | "systemone"
  | "embeddings"
  | "videos"
  | "images"
  | "voice"
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
  grok: "https://api.x.ai",
  typesafe: "https://api.typesafe.ai",
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
  if (platform === "openai" && protocol === "responses" && body) {
    body = structuredClone(body);
    try { normalizeModernCodexResponses(body!); } catch { throw new HttpError(400, "invalid_request"); }
  }
  if (platform === 'antigravity') throw new HttpError(501, 'provider_requires_oauth');
  // Revalidate decrypted routing data; never send a secret to a custom URL or redirect.
  const validated = parseAccountCredentials(
    credentials,
    platform,
    "apikey",
  ) as ApiKeyCredentials;
  if (
    (["openai", "grok"].includes(platform) &&
      !["chat", "responses", "models", "images", ...(platform === "openai" ? ["embeddings"] : ["voice", "videos"])].includes(protocol)) ||
    (platform === "typesafe" && protocol !== "systemone") ||
    (protocol === "systemone" && platform !== "typesafe") ||
    (platform === "anthropic" && !["messages", "models"].includes(protocol)) ||
    (platform === "gemini" && !["gemini", "models"].includes(protocol)) ||
    (path.startsWith("/v1beta/models") && protocol === "models" &&
      platform !== "gemini")
  ) throw new HttpError(501, "provider_protocol_unsupported");
  if (
    protocol === "models" &&
    new URL(request.url).searchParams.has("client_version")
  ) throw new HttpError(501, "codex_manifest_requires_oauth");
  if(protocol==='videos'&&!/^\/v1\/videos(?:\/(?:generations|edits|extensions|[a-zA-Z0-9_-]{1,200})(?:\/content)?)?$/.test(path))throw new HttpError(400,'invalid_video_endpoint');
  if(protocol==='voice'){
    if(!/^\/v1\/(?:tts|stt|realtime|custom-voices(?:\/[A-Za-z0-9_-]{1,200}(?:\/audio)?)?)$/.test(path))throw new HttpError(400,'invalid_voice_endpoint');
    if(validated.base_url==='https://cli-chat-proxy.grok.com')validated.base_url='https://api.x.ai';
  }
  const streaming = protocol === "gemini"
    ? path.endsWith(":streamGenerateContent")
    : body?.stream === true;
  const headers = new Headers({
    "content-type": "application/json",
    accept: streaming ? "text/event-stream" : "application/json",
  });
  let providerPath = path;
  if (platform === "openai" || platform === "grok" || platform === "typesafe") {
    headers.set("authorization", `Bearer ${validated.api_key}`);
    if (protocol === "responses") providerPath = "/v1/responses";
    if (protocol === "embeddings") providerPath = "/v1/embeddings";
    if (protocol === "images") providerPath = path.endsWith("/edits") ? "/v1/images/edits" : "/v1/images/generations";
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
  if (platform === "grok" && protocol!=="voice") grokHeaders(headers, validated.base_url || origins.grok);
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
  const outbound = body ? platform === "grok" && protocol === "images" ? grokImageBody(body,path.endsWith("/edits")) : structuredClone(body) : undefined;
  return {
    url: (validated.base_url || origins[platform]) + providerPath +
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
  if (platform === "openai" || platform === "grok") {
    const totals = protocol === "responses"
      ? (value.response?.usage ?? value.usage)
      : value.usage;
    const input = tokens(
      ["responses", "images"].includes(protocol) ? totals?.input_tokens : totals?.prompt_tokens,
    );
    const output = tokens(
      ["responses", "images"].includes(protocol)
        ? totals?.output_tokens
        : totals?.completion_tokens,
    );
    const cacheRead = tokens(
      ["responses", "images"].includes(protocol)
        ? totals?.input_tokens_details?.cached_tokens
        : totals?.prompt_tokens_details?.cached_tokens,
    );
    if (input !== null) usage.input = input;
    if (output !== null) usage.output = output;
    if (protocol === "embeddings") usage.output = 0;
    if (cacheRead !== null) usage.cacheRead = cacheRead;
    if (value.type === "response.failed" || value.error) {
      usage.outcome = "failed";
    } else if (
      value.type === "response.incomplete" || value.status === "incomplete"
    ) usage.outcome = "incomplete";
    else if (
      value.type === "response.completed" || value.status === "completed" || protocol === "images" && ["image_generation.completed", "image_edit.completed"].includes(value.type)
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
      if (frame.length > (this.protocol === "images" ? 32 * 1024 * 1024 : 1_048_576)) throw new Error("upstream_event_too_large");
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
    if (this.pending.length > (this.protocol === "images" ? 32 * 1024 * 1024 : 1_048_576)) {
      throw new Error("upstream_event_too_large");
    }
  }
}

// Buffer complete frames before forwarding, so an upstream SSE error cannot leak in partial chunks.
function nativeFrames(
  body: ReadableStream<Uint8Array>,
  maxFrame = 1_048_576,
  transformValue?: (value:Item,streaming:boolean)=>Item,
): ReadableStream<Uint8Array> {
  let pending = "";
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const frameBytes=(frame:string)=>{
    if(!transformValue)return encoder.encode(frame);
    const lines=frame.split(/\r?\n/),data=lines.filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trimStart()).join("\n");
    if(!data||data==="[DONE]")return encoder.encode(frame);
    const value=transformValue(JSON.parse(data),true);
    const metadata=lines.filter(line=>line&&!line.startsWith("data:")&&!line.startsWith("event:"));
    return encoder.encode([...metadata,...(typeof value.type==="string"?[`event: ${value.type}`]:[]),`data: ${JSON.stringify(value)}`,"", ""].join("\n"));
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        pending += decoder.decode(bytes, { stream: true });
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(pending))) {
          const length = boundary.index + boundary[0].length;
          if (length > maxFrame) throw new Error("upstream_event_too_large");
          controller.enqueue(frameBytes(pending.slice(0, length)));
          pending = pending.slice(length);
        }
        if (pending.length > maxFrame) {
          throw new Error("upstream_event_too_large");
        }
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending.trim()) {
          controller.enqueue(frameBytes(pending + "\n\n"));
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
  transformValue?: (value:Item,streaming:boolean)=>Item,
): Promise<Response> {
  if (!upstream.body) throw new HttpError(502, "invalid_upstream_response");
  if(protocol==='systemone'){
    const reader=upstream.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4*1024*1024)throw new HttpError(502,'upstream_response_too_large');chunks.push(value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    let value;try{value=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new HttpError(502,'invalid_upstream_response');}
    if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(502,'invalid_upstream_response');
    await finish(upstream.status,{input:systemOneTokens(value.usage?.input_tokens),output:systemOneTokens(value.usage?.output_tokens),cacheCreation:null,cacheRead:null,outcome:'completed'});
    return new Response(bytes,{status:upstream.status,headers:{'content-type':'application/json','cache-control':'no-store'}});
  }

  if (!streaming) {
    let value = await upstream.json();
    if (
      !value || typeof value !== "object" || Array.isArray(value) ||
      value.error || (protocol === "chat" && !Array.isArray(value.choices)) ||
      (protocol === "messages" && value.type !== "message") ||
      (protocol === "responses" && value.object !== "response") ||
      (protocol === "embeddings" && (!Array.isArray(value.data) || !value.data.length || value.data.some((item: Item) => !item || item.object !== "embedding" || !Number.isSafeInteger(item.index) || item.index < 0 || !(typeof item.embedding === "string" && item.embedding.length > 0 || Array.isArray(item.embedding) && item.embedding.length > 0 && item.embedding.every((number: unknown) => typeof number === "number" && Number.isFinite(number)))))) ||
      (protocol === "images" && (!Array.isArray(value.data) || !value.data.length || value.data.some((item: Item) => !item || !(typeof item.b64_json === "string" && item.b64_json || typeof item.url === "string" && item.url)))) ||
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
    return json(upstream.status, transformValue?transformValue(value,false):value);
  }
  const contentType = upstream.headers.get("content-type");
  if (protocol === "images" && contentType?.includes("application/json")) {
    // Some Codex deployments return a complete JSON image even with stream enabled.
    const validated = await nativeResponse(upstream, platform, protocol, false, signal, requestId, async () => {}, path, allowlist, modelSources, aliasModel, started);
    const value = await validated.json();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (const [index, item] of value.data.entries()) {
        const event = { ...item, type: "image_generation.completed", created_at: value.created, output_format: item.output_format ?? value.output_format, ...(index === value.data.length - 1 ? { usage: value.usage } : {}) };
        controller.enqueue(encoder.encode(`event: image_generation.completed\ndata: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    } });
    return nativeResponse(new Response(body, {status:upstream.status,headers:{"content-type":"text/event-stream"}}), platform, protocol, true, signal, requestId, finish, path, allowlist, modelSources, aliasModel, started, transformValue);
  }
  if (contentType && !contentType.includes("text/event-stream")) {
    await upstream.body.cancel();
    throw new HttpError(502, "invalid_upstream_stream");
  }
  return new Response(
    trackedStream(
      nativeFrames(upstream.body, protocol === "images" ? 16 * 1024 * 1024 : undefined, transformValue),
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
