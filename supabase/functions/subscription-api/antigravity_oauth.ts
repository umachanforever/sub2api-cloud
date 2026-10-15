import { accountFetch } from './account_proxy.ts';
import { catalogJSON } from './account_models.ts';
import { apiKeyRequest, type NativeProtocol } from './api_key_provider.ts';
import type { Account } from './accounts.ts';
import { Database, HttpError } from './db.ts';
import { normalizeCodeAssist, type GoogleCredentials } from './google_oauth.ts';
import { cleanAntigravityTools } from './antigravity_schema.ts';
import { antigravityIdentity } from './antigravity_identity.ts';

const PROD = 'https://cloudcode-pa.googleapis.com';
const DAILY = 'https://daily-cloudcode-pa.googleapis.com';
type Outgoing = ReturnType<typeof apiKeyRequest> & { catalog: boolean; fallbackURL: string };

export function antigravityOAuthRequest(credentials: GoogleCredentials, protocol: NativeProtocol, path: string,
  body: Record<string, unknown> | undefined, request: Request, signal: AbortSignal): Outgoing {
  const validated = apiKeyRequest('gemini', { api_key: credentials.access_token }, protocol, path, body, request, signal);
  const project = typeof credentials.project_id === 'string' ? credentials.project_id.trim() : undefined;
  if (!project || project.length > 512 || /[\x00-\x1f\x7f]/.test(project)) throw new HttpError(400, 'antigravity_project_required');
  const headers = new Headers({ 'content-type': 'application/json', authorization: `Bearer ${credentials.access_token}`, 'user-agent': 'antigravity/2.9.1 windows/amd64' });
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
    catalog: false, streaming: validated.streaming,
    init: { method: 'POST', headers, redirect: 'error', signal, body: JSON.stringify({
      project, requestId: 'agent-' + crypto.randomUUID(), userAgent: 'antigravity', requestType: 'agent',
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
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] };
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

export async function forwardAntigravity(db: Database, account: Account, outgoing: Outgoing, path: string, request: Request): Promise<Response> {
  for (const [index, url] of [outgoing.url, outgoing.fallbackURL].entries()) {
    let response: Response;
    try { response = await accountFetch(db, account, url, outgoing.init); }
    catch (error) {
      if (outgoing.init.signal?.aborted) throw new HttpError(504, 'upstream_timeout');
      if (error instanceof HttpError) throw error;
      if (index === 0) continue;
      throw new HttpError(502, 'upstream_request_failed');
    }
    if (index === 0 && ([404, 408, 429].includes(response.status) || response.status >= 500)) { await response.body?.cancel(); continue; }
    if (!response.ok) return response;
    return outgoing.catalog ? modelCatalog(response, path, request) : normalizeCodeAssist(response, outgoing.streaming);
  }
  throw new HttpError(502, 'upstream_request_failed');
}
