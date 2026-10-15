import { apiKeyRequest, type NativeProtocol } from './api_key_provider.ts';
import { HttpError } from './db.ts';
import type { OAuthCredentials } from './gateway.ts';
import { DEFAULT_PROVIDER_CATALOGS } from './provider_models.ts';

import type { GoogleOAuthClients } from './google_oauth_config.ts';
export type { GoogleOAuthClients } from './google_oauth_config.ts';
export type GoogleCredentials = OAuthCredentials & {
  client_secret?: string;
  oauth_type?: string;
  project_id?: string;
};

// Code Assist uses the pinned Gemini catalog, as in the original model-list fallback.
export function googleOAuthCatalog(credentials: GoogleCredentials, path: string, request: Request): Response | undefined {
  if (!credentials.project_id?.trim() || credentials.oauth_type === 'ai_studio') return;
  const model = /\/models\/([^/]+)$/.exec(path)?.[1];
  const models = DEFAULT_PROVIDER_CATALOGS.gemini.map(entry => ({
    name: 'models/' + entry.id, displayName: entry.display_name,
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
  }));
  if (model) {
    const found = models.find(entry => entry.name === 'models/' + decodeURIComponent(model));
    if (!found) throw new HttpError(404, 'model_not_found');
    return Response.json(found);
  }
  const query = new URL(request.url).searchParams;
  const token = query.get('pageToken') || '0';
  const limit = Number(query.get('pageSize') || '1000');
  if (!/^\d+$/.test(token) || !Number.isSafeInteger(Number(token)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new HttpError(400, 'invalid_model_pagination');
  const offset = Number(token), end = offset + limit;
  return Response.json({ models: models.slice(offset, end), ...(end < models.length ? { nextPageToken: String(end) } : {}) });
}

export async function refreshGoogleCredentials(credentials: GoogleCredentials, fetchImpl: typeof fetch, clients?: GoogleOAuthClients): Promise<GoogleCredentials> {
  if (!credentials.refresh_token) throw new HttpError(401, 'oauth_refresh_token_missing');
  const client = credentials.client_id && credentials.client_secret
    ? { clientId: credentials.client_id, clientSecret: credentials.client_secret }
    : credentials.oauth_type === 'ai_studio' ? clients?.aiStudio : clients?.cli;
  if (!client?.clientId || !client.clientSecret) throw new HttpError(503, 'google_oauth_client_not_configured');
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credentials.refresh_token, client_id: client.clientId, client_secret: client.clientSecret }),
  });
  if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, 'google_oauth_refresh_failed'); }
  const token = await response.json();
  if (typeof token.access_token !== 'string' || !token.access_token.trim() || /[\r\n]/.test(token.access_token) ||
      token.refresh_token !== undefined && (typeof token.refresh_token !== 'string' || !token.refresh_token.trim()) ||
      typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0) throw new HttpError(502, 'invalid_oauth_refresh_response');
  return { ...credentials, access_token: token.access_token, refresh_token: token.refresh_token || credentials.refresh_token, expires_at: Date.now() + token.expires_in * 1000 };
}

export function googleOAuthRequest(credentials: GoogleCredentials, protocol: NativeProtocol, path: string, body: Record<string, unknown> | undefined, request: Request, signal: AbortSignal): ReturnType<typeof apiKeyRequest> & { codeAssist: boolean } {
  const native = apiKeyRequest('gemini', { api_key: credentials.access_token }, protocol, path, body, request, signal);
  const headers = new Headers(native.init.headers);
  headers.delete('x-goog-api-key'); headers.set('authorization', `Bearer ${credentials.access_token}`);
  const codeAssist = !!credentials.project_id?.trim() && credentials.oauth_type !== 'ai_studio' && protocol !== 'models';
  if (!codeAssist) return { ...native, init: { ...native.init, headers }, codeAssist: false };
  const match = /^\/v1beta\/models\/([^/]+):(generateContent|streamGenerateContent)$/.exec(path);
  if (!match || !body) throw new HttpError(501, 'provider_protocol_unsupported');
  headers.set('user-agent', 'GeminiCLI/0.1.5 (Windows; AMD64)');
  headers.set('accept', 'text/event-stream');
  return {
    ...native, codeAssist: true,
    url: 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    init: { ...native.init, headers, body: JSON.stringify({ model: decodeURIComponent(match[1]), project: credentials.project_id, request: body }) },
  };
}

// Unwrap Code Assist events before the shared Gemini usage and response handling.
export async function normalizeCodeAssist(upstream: Response, streaming: boolean): Promise<Response> {
  if (!upstream.ok) return upstream;
  if (!upstream.body || !upstream.headers.get('content-type')?.includes('text/event-stream')) throw new HttpError(502, 'invalid_upstream_stream');
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  let pending = '';
  const unwrap = (frame: string): Record<string, any> | undefined => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let wrapper;
    try { wrapper = JSON.parse(data); } catch { throw new HttpError(502, 'invalid_upstream_event'); }
    const value = wrapper.response;
    if (wrapper.error || !value || typeof value !== 'object' || Array.isArray(value) || value.error) throw new HttpError(502, 'invalid_upstream_response');
    return value;
  };
  const frames = upstream.body.pipeThrough(new TransformStream<Uint8Array, Record<string, any>>({
    transform(bytes, controller) {
      pending += decoder.decode(bytes, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        if (boundary.index > 1_048_576) throw new HttpError(502, 'upstream_event_too_large');
        const value = unwrap(pending.slice(0, boundary.index));
        pending = pending.slice(boundary.index + boundary[0].length);
        if (value) controller.enqueue(value);
      }
      if (pending.length > 1_048_576) throw new HttpError(502, 'upstream_event_too_large');
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending.trim()) { const value = unwrap(pending); if (value) controller.enqueue(value); }
    },
  }));
  if (streaming) return new Response(frames.pipeThrough(new TransformStream({
    transform(value, controller) { controller.enqueue(encoder.encode('data: ' + JSON.stringify(value) + '\n\n')); },
  })), { status: upstream.status, headers: { 'content-type': 'text/event-stream' } });
  const reader = frames.getReader();
  const candidates = new Map<number, Record<string, any>>();
  let result: Record<string, any> = {}, bytes = 0, complete = false;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      const value = chunk.value;
      bytes += encoder.encode(JSON.stringify(value)).byteLength;
      if (bytes > 16_777_216) throw new HttpError(502, 'upstream_response_too_large');
      const { candidates: incoming, ...metadata } = value;
      result = { ...result, ...metadata };
      for (const candidate of incoming ?? []) {
        const index = candidate.index ?? 0;
        const previous = candidates.get(index);
        const parts = [...(previous?.content?.parts ?? []), ...(candidate.content?.parts ?? [])];
        candidates.set(index, { ...previous, ...candidate, ...(parts.length ? { content: { ...previous?.content, ...candidate.content, parts } } : {}) });
        if (candidate.finishReason) complete = true;
      }
      if (value.promptFeedback?.blockReason) complete = true;
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  if (!complete || [...candidates.values()].some(candidate => !candidate.finishReason)) throw new HttpError(502, 'incomplete_upstream_response');
  if (candidates.size) result.candidates = [...candidates.values()];
  return Response.json(result, { status: upstream.status });
}
