import { apiKeyRequest, type NativeProtocol } from './api_key_provider.ts';
import { HttpError } from './db.ts';
import type { OAuthCredentials } from './gateway.ts';

const clientId = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const tokenURL = 'https://platform.claude.com/v1/oauth/token';

export function anthropicOAuthRequest(
  credentials: OAuthCredentials,
  protocol: NativeProtocol,
  path: string,
  body: Record<string, unknown> | undefined,
  request: Request,
  signal: AbortSignal,
): ReturnType<typeof apiKeyRequest> {
  const native = apiKeyRequest('anthropic', { api_key: credentials.access_token }, protocol, path, body, request, signal);
  const headers = new Headers(native.init.headers);
  headers.delete('x-api-key');
  headers.set('authorization', `Bearer ${credentials.access_token}`);
  const betas = new Set((headers.get('anthropic-beta') || '').split(',').filter(Boolean));
  betas.add('oauth-2025-04-20');
  headers.set('anthropic-beta', [...betas].join(','));
  return { ...native, init: { ...native.init, headers } };
}

export async function refreshAnthropicCredentials(
  credentials: OAuthCredentials,
  fetchImpl: typeof fetch,
): Promise<OAuthCredentials> {
  if (!credentials.refresh_token) throw new HttpError(401, 'oauth_refresh_token_missing');
  const response = await fetchImpl(tokenURL, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: credentials.refresh_token, client_id: credentials.client_id || clientId }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(502, 'anthropic_oauth_refresh_failed');
  }
  const token = await response.json();
  if (typeof token.access_token !== 'string' || !token.access_token.trim() || /[\r\n]/.test(token.access_token) ||
      token.refresh_token !== undefined && (typeof token.refresh_token !== 'string' || !token.refresh_token.trim()) ||
      typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
    throw new HttpError(502, 'invalid_oauth_refresh_response');
  }
  return { ...credentials, access_token: token.access_token, refresh_token: token.refresh_token || credentials.refresh_token, expires_at: Date.now() + token.expires_in * 1000 };
}
