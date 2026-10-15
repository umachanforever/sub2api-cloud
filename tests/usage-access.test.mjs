import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandler } from './handler.mjs';
import { hashKey } from '../supabase/functions/sub2api/validation.ts';

const config = { url: 'https://db.example', serviceKey: 'service', encryptionKey: 'unused', adminIds: [], dataModel: 'native' };
const now = Math.floor(Date.now() / 1000);
const snapshot = (fetched = now) => ({ codex_usage_updated_at: new Date(fetched * 1000).toISOString(),
  codex_5h_used_percent: 12, codex_5h_window_minutes: 300, codex_5h_reset_at: new Date((now + 3600) * 1000).toISOString(),
  codex_7d_used_percent: 34, codex_7d_window_minutes: 10080, codex_7d_reset_at: new Date((now + 86400) * 1000).toISOString() });
const account = extra => ({ id: '42', platform: 'openai', type: 'oauth', credential_storage: 'vault', credential_version: 4,
  privacy_mode: 'training_off', credentials: { access_token: 'provider-secret', refresh_token: 'refresh-secret', expires_at: Date.now() + 3600_000, chatgpt_account_id: 'private-provider-id' },
  quota_snapshot: snapshot(), ...extra });
const request = (query = '', headers = {}) => new Request('https://edge/functions/v1/sub2api/v1/usage' + query, {
  headers: { authorization: 'Bearer usage-token', ...headers },
});
const handler = fn => createHandler(config, async (url, init) => {
  const parsed = new URL(url);
  return fn(parsed, init, init?.body && JSON.parse(init.body));
});
const usage = () => ({ rate_limit: { allowed: true, limit_reached: false,
  primary_window: { used_percent: 22, limit_window_seconds: 18000, reset_after_seconds: 1000, reset_at: now + 1000 },
  secondary_window: { used_percent: 44, limit_window_seconds: 604800, reset_after_seconds: 2000, reset_at: now + 2000 } },
  email: 'never-return@example.com', account_id: 'never-return-provider-id', credits: { has_credits: false, unlimited: false } });

test('usage reads validate the supplied key on every request and project cached provider windows only', async () => {
  let reads = 0;
  const app = handler((url, init, args) => {
    assert.equal(url.pathname, '/rest/v1/rpc/s2a_personal_usage_accounts');
    assert.equal(args.p_key_hash.length, 64); assert.equal(args.p_client_ip, '203.0.113.4');
    reads++; return Response.json({ accounts: [account()] });
  });
  for (let i = 0; i < 2; i++) {
    const response = await app(request('', { 'x-forwarded-for': '203.0.113.4, 10.0.0.1' }));
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json(), value = body.accounts[0];
    assert.equal(value.five_hour.used_percent, 12); assert.equal(value.seven_day.used_percent, 34);
    assert.equal(value.five_hour.remaining_percent, 88); assert.equal(value.five_hour.window_seconds, 18000);
    assert.equal(value.cached, true); assert.equal(value.stale, false);
    assert.equal(JSON.stringify(body).includes('secret'), false); assert.equal(JSON.stringify(body).includes('private-provider'), false);
  }
  assert.equal(reads, 2);
});
test('expired snapshots and explicit refresh query the provider and persist canonical window metadata', async () => {
  for (const [query, headers, cached] of [['', {}, snapshot(now - 61)], ['?refresh=true', {}, snapshot()], ['', { 'Cache-Control': 'no-cache' }, snapshot()]]) {
    let providerReads = 0, saves = 0;
    const app = handler((url, init, args) => {
      if (url.pathname.endsWith('/s2a_personal_usage_accounts')) return Response.json({ accounts: [account({ quota_snapshot: cached })] });
      if (url.hostname === 'chatgpt.com') {
        assert.equal(url.pathname, '/backend-api/wham/usage');
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer provider-secret');
        providerReads++; return Response.json(usage());
      }
      assert.ok(url.pathname.endsWith('/s2a_personal_windows_save'));
      assert.equal(args.p_account_id, '42'); assert.equal(args.p_version, 4); assert.equal(args.p_windows.codex_5h_used_percent, 22);
      saves++; return Response.json(true);
    });
    const response = await app(request(query, headers)); assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.accounts[0].cached, false); assert.equal(body.accounts[0].stale, false);
    assert.equal(body.accounts[0].seven_day.used_percent, 44);
    assert.equal(providerReads, 1); assert.equal(saves, 1);
    assert.equal(JSON.stringify(body).includes('never-return'), false);
  }
});
test('provider failure labels fallback snapshots stale and leaves unknown windows null', async () => {
  for (const cached of [snapshot(now - 70), {}]) {
    const app = handler(url => url.hostname === 'chatgpt.com' ? new Response('private-upstream-error', { status: 403 }) : Response.json({ accounts: [account({ quota_snapshot: cached })] }));
    const response = await app(request()); const body = await response.json();
    assert.equal(body.accounts[0].stale, true); assert.equal(body.accounts[0].error, 'openai_quota_upstream_error');
    assert.equal(JSON.stringify(body).includes('private-upstream-error'), false);
    if (!cached.codex_usage_updated_at) { assert.equal(body.accounts[0].five_hour, null); assert.equal(body.accounts[0].fetched_at, null); }
  }
});
test('invalid, revoked, group-forbidden, and IP-restricted keys are rejected before any provider read', async () => {
  for (const [error, status] of [['invalid_api_key', 401], ['group_forbidden', 403], ['ip_forbidden', 403], ['account_not_found', 404]]) {
    const app = handler(url => { assert.ok(url.pathname.endsWith('/s2a_personal_usage_accounts')); return Response.json({ error, status }); });
    assert.equal((await app(request())).status, status);
  }
  const app = handler(() => { throw Error('Must not query'); });
  assert.equal((await app(new Request('https://edge/v1/usage'))).status, 401);
  for (const query of ['?account_id=-1', '?account_id=9223372036854775808', '?refresh=maybe']) assert.equal((await app(request(query))).status, 400);
});
test('account selection preserves bigint identity and API keys hash identically to normal inference', async () => {
  const app = handler(async (url, init, args) => {
    assert.equal(args.p_key_hash, await hashKey('usage-token')); assert.equal(args.p_account_id, '9007199254740993');
    return Response.json({ accounts: [] });
  });
  const response = await app(request('?account_id=9007199254740993'));
  assert.deepEqual((await response.json()).accounts, []);
});
