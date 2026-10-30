import {IMAGE_CHAT_FRAME_LIMIT} from './chat_images.ts';
import {enableAntigravityTools,antigravityHostedResponse,type AntigravityToolContext} from './antigravity_tools.ts';
import { accountFetch } from './account_proxy.ts';
import { catalogJSON } from './account_models.ts';
import { apiKeyRequest, type NativeProtocol } from './api_key_provider.ts';
import type { Account } from './accounts.ts';
import { Database, HttpError } from './db.ts';
import { normalizeCodeAssist, type GoogleCredentials } from './google_oauth.ts';
import { cleanAntigravityTools } from './antigravity_schema.ts';
import { claudeToAntigravity, antigravityToClaude, antigravitySearchOnly } from './antigravity_claude.ts';
import { antigravityIdentity,antigravityUserAgent } from './antigravity_identity.ts';

const PROD = 'https://cloudcode-pa.googleapis.com';
const DAILY = 'https://daily-cloudcode-pa.googleapis.com';
type Outgoing = ReturnType<typeof apiKeyRequest> & { catalog: boolean; fallbackURL: string; claudeModel?: string; upstreamModel?: string };

export function antigravityOAuthRequest(credentials: GoogleCredentials, protocol: NativeProtocol, path: string,
  body: Record<string, unknown> | undefined, request: Request, signal: AbortSignal, responseModel?: string): Outgoing {
  const claudeModel = protocol === 'messages' && typeof body?.model === 'string' ? body.model : undefined;
  const claudeStreaming = body?.stream === true;
  const searchOnly = !!(claudeModel && antigravitySearchOnly(body!));
  const targetModel = searchOnly ? 'gemini-2.5-flash' : claudeModel;
  if (claudeModel) {
    body = claudeToAntigravity({ ...body!, model: targetModel });
    protocol = 'gemini';
    path = `/v1beta/models/${encodeURIComponent(targetModel!)}:${claudeStreaming ? 'streamGenerateContent' : 'generateContent'}`;
  }
  const validated = apiKeyRequest('gemini', { api_key: credentials.access_token }, protocol, path, body, request, signal);
  const project = typeof credentials.project_id === 'string' ? credentials.project_id.trim() : undefined;
  if (!project || project.length > 512 || /[\x00-\x1f\x7f]/.test(project)) throw new HttpError(400, 'antigravity_project_required');
  const headers = new Headers({ 'content-type': 'application/json', authorization: `Bearer ${credentials.access_token}`, 'user-agent': antigravityUserAgent });
  if (protocol === 'models') return {
    url: PROD + '/v1internal:fetchAvailableModels', fallbackURL: DAILY + '/v1internal:fetchAvailableModels', catalog: true, streaming: false,
    init: { method: 'POST', headers, body: JSON.stringify({ project }), redirect: 'error', signal },
  };
  const match = /^\/v1beta\/models\/([^/]+):(generateContent|streamGenerateContent)$/.exec(path);
  if (!match || !body) throw new HttpError(501, 'provider_protocol_unsupported');
  const inner = structuredClone(body);
  cleanAntigravityTools(inner);
  const system = inner.systemInstruction;
  if (system !== undefined && (!system || typeof system !== 'object' || Array.isArray(system))) throw new HttpError(400, 'invalid_system_instruction');
  const instruction = (system ?? {}) as Record<string, unknown>;
  const parts = instruction.parts;
  if (parts !== undefined && !Array.isArray(parts)) throw new HttpError(400, 'invalid_system_instruction');
  const existing = (parts ?? []) as Record<string, unknown>[];
  if (!existing.some(part => typeof part?.text === 'string' && part.text.includes('You are Antigravity'))) {
    inner.systemInstruction = { ...instruction, parts: [{ text: antigravityIdentity }, ...existing] };
  }
  return {
    url: DAILY + '/v1internal:streamGenerateContent?alt=sse', fallbackURL: PROD + '/v1internal:streamGenerateContent?alt=sse',
    catalog: false, streaming: validated.streaming, upstreamModel: decodeURIComponent(match[1]), ...(claudeModel ? { claudeModel: responseModel ?? claudeModel } : {}),
    init: { method: 'POST', headers, redirect: 'error', signal, body: JSON.stringify({
      project, requestId: 'agent-' + crypto.randomUUID(), userAgent: 'antigravity', requestType: searchOnly ? 'web_search' : 'agent',
      model: decodeURIComponent(match[1]), request: inner,
    }) },
  };
}

async function modelCatalog(response: Response, path: string, request: Request): Promise<Response> {
  const value = await catalogJSON(response, false, 2 * 1024 * 1024);
  if (!value.models || typeof value.models !== 'object' || Array.isArray(value.models) || Object.keys(value.models).length > 1000) throw new HttpError(502, 'invalid_upstream_model_catalog');
  const models = Object.entries(value.models).map(([id, metadata]) => {
    if (!/^[a-zA-Z0-9._-]{1,200}$/.test(id) || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new HttpError(502, 'invalid_upstream_model_catalog');
    const row = metadata as Record<string, unknown>;
    return { name: 'models/' + id, displayName: typeof row.displayName === 'string' ? row.displayName.slice(0, 512) : id,
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'] };
  });
  const id = /\/models\/([^/]+)$/.exec(path)?.[1];
  if (id) {
    const entry = models.find(model => model.name === 'models/' + decodeURIComponent(id));
    if (!entry) throw new HttpError(404, 'model_not_found');
    return Response.json(entry);
  }
  const query = new URL(request.url).searchParams, token = query.get('pageToken') || '0', limit = Number(query.get('pageSize') || '1000');
  if (!/^\d+$/.test(token) || !Number.isSafeInteger(Number(token)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new HttpError(400, 'invalid_model_pagination');
  const offset = Number(token), end = offset + limit;
  return Response.json({ models: models.slice(offset, end), ...(end < models.length ? { nextPageToken: String(end) } : {}) });
}

export async function forwardAntigravity(db: Database, account: Account, outgoing: Outgoing, path: string, request: Request, hosted?:AntigravityToolContext): Promise<Response> {
  if (outgoing.claudeModel) {
    const envelope = JSON.parse(String(outgoing.init.body ?? '{}'));
    if (!envelope.request.sessionId) {
      const text = envelope.request.contents.find((content: { role: string; parts: { text?: string }[] }) => content.role === 'user' && content.parts[0]?.text)?.parts[0].text;
      const bytes = text ? new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))) : crypto.getRandomValues(new Uint8Array(8));
      envelope.request.sessionId = '-' + (new DataView(bytes.buffer).getBigUint64(0) & 0x7fffffffffffffffn).toString();
      outgoing.init = { ...outgoing.init, body: JSON.stringify(envelope) };
    }
  }
  const envelope = JSON.parse(String(outgoing.init.body ?? '{}'));
  const names = hosted && !outgoing.catalog ? enableAntigravityTools(envelope, hosted.images) : new Set<string>();
  const send = async (body:Record<string,any>,signal:AbortSignal):Promise<Response> => {
    for (const [index, url] of [outgoing.url, outgoing.fallbackURL].entries()) {
      let response: Response;
      try { response = await accountFetch(db, account, url, {...outgoing.init,body:JSON.stringify(body),signal}); }
      catch (error) {
        if (signal.aborted) throw new HttpError(504, 'upstream_timeout');
        if (error instanceof HttpError) throw error;
        if (index === 0) continue;
        throw new HttpError(502, 'upstream_request_failed');
      }
      if (index === 0 && ([404, 408, 429].includes(response.status) || response.status >= 500)) { await response.body?.cancel(); continue; }
      return response;
    }
    throw new HttpError(502, 'upstream_request_failed');
  };
  let response = await send(envelope, outgoing.init.signal!);
  if (!response.ok) return response;
  if (outgoing.catalog) return modelCatalog(response, path, request);
  if (hosted) response=antigravityHostedResponse(response,envelope,names,send,hosted);
  // Inline generated images must survive every downstream SSE conversion stage.
  const maxFrame=hosted?.images?IMAGE_CHAT_FRAME_LIMIT:1_048_576;
  const normalized = await normalizeCodeAssist(response, outgoing.streaming, maxFrame);
  return outgoing.claudeModel ? antigravityToClaude(normalized, outgoing.streaming, outgoing.claudeModel, maxFrame) : normalized;
}
