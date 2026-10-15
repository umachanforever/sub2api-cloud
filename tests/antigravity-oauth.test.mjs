import assert from 'node:assert/strict';
import test from 'node:test';
import { proxy } from '../supabase/functions/sub2api/proxy.ts';
import { antigravityOAuthRequest, forwardAntigravity } from '../supabase/functions/sub2api/antigravity_oauth.ts';
import { googleOAuthClients } from '../supabase/functions/sub2api/google_oauth_config.ts';
import { oauthSecrets } from '../scripts/deploy.mjs';

const events = [
  { candidates: [{ content: { role: 'model', parts: [{ text: '你好', thoughtSignature: 'public-signature' }] } }] },
  { candidates: [{ content: { parts: [{ text: '世界' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, thoughtsTokenCount: 3, cachedContentTokenCount: 4 } },
];
function sse() {
  const bytes = new TextEncoder().encode(events.map(response => 'data: ' + JSON.stringify({ response, traceId: 'private-trace' }) + '\n\n').join(''));
  let offset = 0;
  return new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else c.enqueue(bytes.slice(offset, ++offset)); } }), { headers: { 'content-type': 'text/event-stream', 'set-cookie': 'never-forward-cookie' } });
}
async function fixture({ stream = false, expired = false, reject = false, fallback = false, models = false } = {}) {
  let credentials = { access_token: 'old-provider-token', refresh_token: 'private-refresh', expires_at: Date.now() + (expired ? -1000 : 3600000), project_id: 'private-project', metadata: { preserved: true } };
  let version = 1, refreshes = 0;
  const calls = [], saved = [], finished = [];
  const db = {
    config: { dataModel: 'native', googleOAuth: { cli: { clientId: 'wrong-client', clientSecret: 'wrong-secret' }, antigravity: { clientId: 'antigravity-id', clientSecret: 'antigravity-secret' } } },
    async rpc(name, body) {
      if (name === 's2a_personal_acquire') return { lease_id: crypto.randomUUID(), account: { id: '1', platform: 'antigravity', type: 'oauth', credential_storage: 'vault', credential_version: version, credentials }, model_sources: { mapping: { alias: 'gemini-test' }, include_upstream: true } };
      if (name === 's2a_gateway_refresh_acquire') return true;
      if (name === 's2a_gateway_account_snapshot') return { id: '1', credentials, credential_version: version };
      if (name === 's2a_gateway_refresh_save') { saved.push(body); credentials = body.p_credentials; version++; return true; }
      if (name === 's2a_gateway_refresh_release' || name === 's2a_personal_ops_error_record') return;
      if (name === 's2a_personal_finish') { finished.push(body); return; }
      assert.fail('Unexpected RPC ' + name);
    },
    async fetchImpl(url, init) {
      if (url === 'https://oauth2.googleapis.com/token') {
        refreshes++; const form = new URLSearchParams(init.body);
        assert.equal(form.get('client_id'), 'antigravity-id'); assert.equal(form.get('client_secret'), 'antigravity-secret');
        assert.equal(form.get('refresh_token'), 'private-refresh'); assert.equal(init.redirect, 'error');
        return Response.json({ access_token: 'new-provider-token', expires_in: 3600 });
      }
      calls.push(url);
      const headers = new Headers(init.headers), body = JSON.parse(init.body);
      assert.equal(headers.get('authorization'), 'Bearer ' + credentials.access_token);
      assert.equal(headers.get('user-agent'), 'antigravity/2.9.1 windows/amd64');
      assert.equal(headers.get('x-goog-api-key'), null); assert.equal(init.redirect, 'error');
      assert.equal(body.project, 'private-project');
      if (reject && calls.length === 1) return new Response('private-error', { status: 401 });
      if (fallback && calls.length === 1) return new Response('private-error', { status: 503 });
      if (models) {
        assert.equal(new URL(url).pathname, '/v1internal:fetchAvailableModels');
        return Response.json({ models: { 'gemini-test': { displayName: 'Test', quotaInfo: { privateQuota: true }, privateMetadata: 'private-info' } }, deprecatedModelIds: { 'private-old': {} } });
      }
      assert.equal(new URL(url).pathname, '/v1internal:streamGenerateContent');
      assert.equal(body.model, 'gemini-test'); assert.match(body.requestId, /^agent-/);
      assert.equal(body.userAgent, 'antigravity'); assert.equal(body.requestType, 'agent');
      assert.match(body.request.systemInstruction.parts[0].text, /You are Antigravity/);
      assert.equal(body.request.systemInstruction.parts[1].text, 'Retain caller instructions');
      assert.deepEqual(body.request.contents, [{ role: 'user', parts: [{ text: 'Hello' }] }]);
      return sse();
    },
  };
  const path = models ? '/v1/models' : '/v1beta/models/alias:' + (stream ? 'streamGenerateContent' : 'generateContent');
  const request = new Request('https://gateway.test' + path, { method: models ? 'GET' : 'POST', ...(models ? {} : { body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Hello' }] }], systemInstruction: { parts: [{ text: 'Retain caller instructions' }] } }) }) });
  const response = await proxy(request, path, 'existing-key', db, { requestId: crypto.randomUUID(), started: Date.now() });
  return { response, text: await response.text(), calls, saved, finished, refreshes };
}
for (const stream of [false, true]) test(`Antigravity Gemini OAuth ${stream ? 'SSE' : 'JSON'} uses native provider envelopes, aliases, and raw usage`, async () => {
  const result = await fixture({ stream });
  assert.equal(result.response.status, 200); assert.match(result.text, /你好/); assert.match(result.text, /世界/); assert.match(result.text, /public-signature/);
  assert.doesNotMatch(result.text, /private-|provider-token|never-forward-cookie/); assert.equal(result.response.headers.get('set-cookie'), null);
  assert.equal(result.finished.length, 1); assert.equal(result.finished[0].p_input_tokens, 7);
  assert.equal(result.finished[0].p_output_tokens, 5); assert.equal(result.finished[0].p_cache_read_tokens, 4);
});
for (const condition of ['expired', 'reject']) test(`Antigravity ${condition} credentials refresh with the dedicated OAuth client`, async () => {
  const result = await fixture({ [condition]: true }); assert.equal(result.refreshes, 1); assert.equal(result.saved.length, 1);
  assert.equal(result.saved[0].p_credentials.project_id, 'private-project'); assert.deepEqual(result.saved[0].p_credentials.metadata, { preserved: true });
  assert.equal(result.saved[0].p_credentials.refresh_token, 'private-refresh'); assert.match(result.saved[0].p_credentials.expires_at, /^\d{4}-\d{2}-\d{2}T/);
});
test('Antigravity catalogs query the real provider and expose sanitized mapped model ids', async () => {
  const result = await fixture({ models: true }); const value = JSON.parse(result.text);
  assert.equal(value.data[0].id, 'gemini-test'); assert.equal(value.data[1].id, 'alias'); assert.doesNotMatch(result.text, /private-|quotaInfo|deprecatedModel/);
});
test('Antigravity falls back between the fixed daily and production origins before consuming a response', async () => {
  for (const models of [false, true]) {
    const result = await fixture({ fallback: true, models }); assert.equal(result.calls.length, 2);
    assert.equal(new URL(result.calls[0]).hostname, models ? 'cloudcode-pa.googleapis.com' : 'daily-cloudcode-pa.googleapis.com');
    assert.equal(new URL(result.calls[1]).hostname, models ? 'daily-cloudcode-pa.googleapis.com' : 'cloudcode-pa.googleapis.com');
  }
});
test('Antigravity rejects missing projects and unsupported protocols before network dispatch', () => {
  const request = new Request('https://edge.test/v1/models'), signal = new AbortController().signal;
  assert.throws(() => antigravityOAuthRequest({ access_token: 'private' }, 'models', '/v1/models', undefined, request, signal), { code: 'antigravity_project_required' });
  assert.throws(() => antigravityOAuthRequest({ access_token: 'private', project_id: 'project' }, 'messages', '/v1/messages', {}, request, signal), { code: 'provider_protocol_unsupported' });
});
test('Antigravity endpoint fallback honors request cancellation and configuration errors', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const outgoing = { url: 'https://fixed.test', fallbackURL: 'https://other.test', init: { signal: controller.signal }, catalog: false, streaming: true };
  await assert.rejects(forwardAntigravity({ fetchImpl() { calls++; throw Error('private-network-details'); } }, {}, outgoing, '', new Request('https://edge.test')), { code: 'upstream_timeout' });
  assert.equal(calls, 1);
});
test('Antigravity private client configuration is paired and installed by the deployment helper', () => {
  const env = { ANTIGRAVITY_OAUTH_CLIENT_ID: 'test-id', ANTIGRAVITY_OAUTH_CLIENT_SECRET: 'test-secret' };
  assert.deepEqual(googleOAuthClients(env), { antigravity: { clientId: 'test-id', clientSecret: 'test-secret' } });
  assert.equal(oauthSecrets(env), 'ANTIGRAVITY_OAUTH_CLIENT_ID=test-id\nANTIGRAVITY_OAUTH_CLIENT_SECRET=test-secret\n');
  assert.throws(() => googleOAuthClients({ ANTIGRAVITY_OAUTH_CLIENT_ID: 'incomplete' }), /together/);
});
