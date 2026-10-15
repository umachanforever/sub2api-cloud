import { apiKeyRequest, type NativeProtocol } from './api_key_provider.ts';
import { HttpError } from './db.ts';
import type { OAuthCredentials } from './gateway.ts';
import { GROK_CLIENT_ID, grokOrigin } from './grok_config.ts';

export async function refreshGrokCredentials(credentials: OAuthCredentials, fetcher: typeof fetch): Promise<OAuthCredentials> {
  if (!credentials.refresh_token || /[\x00-\x1f\x7f]/.test(credentials.refresh_token)) throw new HttpError(401, 'oauth_refresh_token_missing');
  const clientId = credentials.client_id || GROK_CLIENT_ID;
  if (typeof clientId !== 'string' || clientId.length > 512 || /[\x00-\x1f\x7f]/.test(clientId)) throw new HttpError(400, 'invalid_client_id');
  const response = await fetcher('https://auth.x.ai/oauth2/token', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'sub2api-grok-oauth/1.0' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: credentials.refresh_token }),
  });
  if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, 'grok_oauth_refresh_failed'); }
  const token = await response.json();
  if (typeof token.access_token !== 'string' || !token.access_token.trim() || token.access_token.length > 32768 || /[\x00-\x1f\x7f]/.test(token.access_token) ||
    token.refresh_token !== undefined && (typeof token.refresh_token !== 'string' || !token.refresh_token.trim() || token.refresh_token.length > 32768 || /[\x00-\x1f\x7f]/.test(token.refresh_token)) ||
    typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0 || token.expires_in > 31536000) throw new HttpError(502, 'invalid_oauth_refresh_response');
  return { ...credentials, client_id: clientId, access_token: token.access_token, refresh_token: token.refresh_token || credentials.refresh_token,
    expires_at: Date.now() + token.expires_in * 1000 };
}
export function grokOAuthRequest(credentials: OAuthCredentials, protocol: NativeProtocol, path: string, body: Record<string, unknown> | undefined, request: Request, signal: AbortSignal): ReturnType<typeof apiKeyRequest> {
  const base = grokOrigin((credentials as OAuthCredentials & { base_url?: unknown }).base_url, true);
  return apiKeyRequest('grok', { api_key: credentials.access_token, base_url: base }, protocol, path, body, request, signal);
}
