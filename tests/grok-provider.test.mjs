import test from 'node:test';
import assert from 'node:assert/strict';
import { proxy } from '../supabase/functions/subscription-api/proxy.ts';
import { apiKeyRequest } from '../supabase/functions/subscription-api/api_key_provider.ts';
import { refreshGrokCredentials, grokOAuthRequest } from '../supabase/functions/subscription-api/grok_oauth.ts';
import { GROK_CLIENT_ID, grokOrigin } from '../supabase/functions/subscription-api/grok_config.ts';

async function fixture({ type = 'oauth', protocol = 'chat', stream = false, expired = false, reject = false, unknownExpiry = false, region = false, limited = false } = {}) {
  let version = 1, refreshes = 0;
  let credentials = type === 'apikey' ? { api_key: 'provider-key' } : { access_token: 'provider-access', refresh_token: 'provider-refresh', client_id: 'stored-public-client', expires_at: Date.now() + (expired ? -1000 : 3600000), subscription_tier: 'preserved-tier', metadata: { retained: true } };
  if (unknownExpiry) delete credentials.expires_at;
  if (region) credentials.base_url = 'https://eu-west-1.api.x.ai/v1';
  const calls = [], saved = [], finished = [];
  const db = { config: { dataModel: 'native' }, async rpc(name, body) {
    if (name === 's2a_personal_acquire') return { lease_id: 'lease', account: { id: '1', platform: 'grok', type, credential_storage: 'vault', credential_version: version, credentials } };
    if (name === 's2a_gateway_refresh_acquire') return true;
    if (name === 's2a_gateway_account_snapshot') return { id: '1', credential_version: version, credentials };
    if (name === 's2a_gateway_refresh_save') { saved.push(body); credentials = body.p_credentials; version++; return true; }
    if (name === 's2a_gateway_refresh_release' || name === 's2a_personal_ops_error_record') return;
    if (name === 's2a_personal_finish') { finished.push(body); return; }
    assert.fail(name);
  }, async fetchImpl(url, init) {
    const headers = new Headers(init.headers);
    assert.equal(init.redirect, 'error');
    if (url === 'https://auth.x.ai/oauth2/token') {
      refreshes++;
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('grant_type'), 'refresh_token'); assert.equal(form.get('refresh_token'), 'provider-refresh'); assert.equal(form.get('client_id'), 'stored-public-client');
      return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 });
    }
    calls.push(url);
    const origin = region ? 'https://eu-west-1.api.x.ai' : type === 'oauth' ? 'https://cli-chat-proxy.grok.com' : 'https://api.x.ai';
    assert.equal(new URL(url).origin, origin);
    assert.equal(headers.get('authorization'), 'Bearer ' + (credentials.api_key ?? credentials.access_token));
    assert.equal(headers.get('x-api-key'), null); assert.notEqual(headers.get('user-agent'), 'untrusted-client');
    assert.equal(headers.get('x-grok-client-version'), '1.0.46');
    assert.equal(headers.get('x-xai-token-auth'), origin.includes('cli-chat-proxy') ? 'xai-grok-cli' : null);
    if (reject && calls.length === 1) return new Response('private-error', { status: 401 });
    if (protocol === 'models') return Response.json({ object: 'list', data: [{ id: 'grok-test', object: 'model', owned_by: 'xai' }] });
    const input = JSON.parse(init.body); assert.equal(input.model, 'grok-test'); assert.equal(input.stream, stream);
    const usage = protocol === 'responses' ? { input_tokens: 8, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } } : { prompt_tokens: 8, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } };
    const value = protocol === 'responses' ? { object: 'response', status: limited ? 'incomplete' : 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }], usage } : { object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: limited ? 'length' : 'stop' }], usage };
    if (!stream) return Response.json(value, { headers: { 'set-cookie': 'never-forward' } });
    const events = protocol === 'responses' ? [{ type: 'response.output_text.delta', delta: 'hello' }, { type: limited ? 'response.incomplete' : 'response.completed', response: value }] : [{ choices: [{ delta: { content: 'hello' } }] }, { choices: [{ delta: {}, finish_reason: limited ? 'length' : 'stop' }], usage }];
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'set-cookie': 'never-forward' } });
  } };
  const path = protocol === 'models' ? '/v1/models' : protocol === 'chat' ? '/v1/chat/completions' : '/v1/responses';
  const body = { model: 'grok-test', stream, ...(protocol === 'chat' ? { messages: [{ role: 'user', content: 'hello' }] } : { input: 'hello' }) };
  const request = new Request('https://edge.test' + path, { method: protocol === 'models' ? 'GET' : 'POST', headers: { 'user-agent': 'untrusted-client', 'x-api-key': 'client-key' }, ...(protocol === 'models' ? {} : { body: JSON.stringify(body) }) });
  const response = await proxy(request, path, 'sk-client', db, { requestId: crypto.randomUUID(), started: Date.now() });
  return { response, text: await response.text(), calls, saved, finished, refreshes };
}
for (const type of ['oauth', 'apikey']) for (const protocol of ['chat', 'responses']) for (const stream of [false, true]) test(`Grok ${type} ${protocol} ${stream ? 'SSE' : 'JSON'} forwards natively and records raw usage`, async () => {
  const result = await fixture({ type, protocol, stream });
  assert.equal(result.response.status, 200); assert.match(result.text, /hello/); assert.equal(result.response.headers.get('set-cookie'), null);
  assert.equal(result.finished.length, 1); assert.equal(result.finished[0].p_input_tokens, 8); assert.equal(result.finished[0].p_output_tokens, 4); assert.equal(result.finished[0].p_cache_read_tokens, 3);
  assert.doesNotMatch(result.text, /provider-access|provider-key|private-error/);
});
for (const mode of ['expired', 'reject', 'unknownExpiry']) test(`Grok ${mode} OAuth credentials refresh through fenced Vault writes`, async () => {
  const result = await fixture({ [mode]: true, region: true });
  assert.equal(result.refreshes, 1); assert.equal(result.saved.length, 1);
  assert.equal(result.saved[0].p_credentials.refresh_token, 'rotated-refresh'); assert.equal(result.saved[0].p_credentials.subscription_tier, 'preserved-tier');
  assert.deepEqual(result.saved[0].p_credentials.metadata, { retained: true });
  assert.equal(result.saved[0].p_credentials.base_url, 'https://eu-west-1.api.x.ai/v1'); assert.match(result.saved[0].p_credentials.expires_at, /^\d{4}-\d{2}-\d{2}T/);
});
for (const type of ['oauth', 'apikey']) test(`Grok ${type} catalogs use the provider endpoint`, async () => {
  const result = await fixture({ type, protocol: 'models' }); assert.equal(JSON.parse(result.text).data[0].id, 'grok-test');
});
test('Grok trusted origin validation rejects custom, lookalike and credential-bearing URLs', () => {
  for (const url of ['https://api.x.ai.attacker.test', 'http://api.x.ai/v1', 'https://user:secret@api.x.ai', 'https://api.x.ai/v1?secret=x', 'https://api.x.ai/redirect', 'https://cli-chat-proxy.grok.com.evil/v1']) assert.throws(() => grokOrigin(url));
  const request = new Request('https://edge.test/v1/chat/completions'), signal = new AbortController().signal;
  assert.throws(() => grokOAuthRequest({ access_token: 'private', base_url: 'https://attacker.test' }, 'chat', '/v1/chat/completions', {}, request, signal), { code: 'custom_base_url_unsupported' });
  assert.throws(() => apiKeyRequest('grok', { api_key: 'private' }, 'messages', '/v1/messages', {}, request, signal), { code: 'provider_protocol_unsupported' });
});
test('Grok refresh preserves an unrotated refresh token and rejects malformed replacements', async () => {
  const input = { access_token: 'old', refresh_token: 'refresh', custom: 'retained' };
  const result = await refreshGrokCredentials(input, async (url, init) => {
    assert.equal(url, 'https://auth.x.ai/oauth2/token'); assert.equal(new URLSearchParams(init.body).get('client_id'), GROK_CLIENT_ID);
    return Response.json({ access_token: 'new', expires_in: 3600 });
  });
  assert.equal(result.refresh_token, 'refresh'); assert.equal(result.custom, 'retained');
  for (const token of [{ access_token: 'new', expires_in: 0 }, { access_token: 'new\r\n', expires_in: 3600 }, { access_token: 'new', refresh_token: '', expires_in: 3600 }]) await assert.rejects(refreshGrokCredentials(input, async () => Response.json(token)), { code: 'invalid_oauth_refresh_response' });
});

for (const protocol of ['chat', 'responses']) for (const stream of [false, true]) test(`Grok ${protocol} ${stream ? 'SSE' : 'JSON'} limits settle with the native interrupted outcome`, async () => {
  const result = await fixture({ protocol, stream, limited: true });
  assert.equal(result.finished.length, 1); assert.equal(result.finished[0].p_outcome, 'interrupted');
  assert.equal(result.finished[0].p_output_tokens, 4);
});
