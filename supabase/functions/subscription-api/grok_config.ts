// Official endpoints and public CLI identity from internal/pkg/xai (LGPL-3.0-or-later).
import { HttpError } from './db.ts';
export const GROK_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const GROK_CLI_VERSION = '1.0.46';
const origins = new Set(['https://api.x.ai', 'https://us-east-1.api.x.ai', 'https://us-west-2.api.x.ai', 'https://eu-west-1.api.x.ai', 'https://cli-chat-proxy.grok.com']);
export function grokOrigin(value: unknown, oauth = false): string {
  if (value === undefined || value === '') return oauth ? 'https://cli-chat-proxy.grok.com' : 'https://api.x.ai';
  let url: URL;
  try { if (typeof value !== 'string') throw Error(); url = new URL(value); } catch { throw new HttpError(400, 'invalid_base_url'); }
  if (!origins.has(url.origin) || url.username || url.password || url.search || url.hash || !['', '/v1'].includes(url.pathname.replace(/\/$/, ''))) throw new HttpError(501, 'custom_base_url_unsupported');
  return url.origin;
}
export function grokHeaders(headers: Headers, origin: string) {
  headers.set('user-agent', `grok-pager/${GROK_CLI_VERSION} grok-shell/${GROK_CLI_VERSION} (linux; x86_64)`);
  headers.set('x-grok-client-version', GROK_CLI_VERSION);
  headers.set('x-grok-client-identifier', 'grok-pager');
  if (origin === 'https://cli-chat-proxy.grok.com') {
    headers.set('x-xai-token-auth', 'xai-grok-cli');
    headers.set('x-grok-client-mode', 'interactive');
    headers.set('x-authenticateresponse', 'authenticate-response');
  }
}
