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
    assert.equal(body.timezone, 'Asia/Shanghai');
    for (const row of [value.five_hour, value.seven_day, ...value.windows]) {
      assert.ok(row.reset_at.endsWith('+08:00'));
      const source = row.window_seconds === 18000 ? snapshot().codex_5h_reset_at : snapshot().codex_7d_reset_at;
      assert.equal(Date.parse(row.reset_at), Date.parse(source));
    }
    assert.ok(value.fetched_at.endsWith('+08:00'));
    assert.equal(Date.parse(value.fetched_at), Date.parse(snapshot().codex_usage_updated_at));
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

test('direct read-only links show separate enabled account names and windows',async()=>{
 const key='sk-usage-'+'a'.repeat(64);
 const app=handler((url,init,args)=>{
  assert.equal(args.p_key_hash.length,64);
  return Response.json({accounts:[account({id:'1',name:'First',status:'active'}),account({id:'2',name:'Second',status:'active',quota_snapshot:{...snapshot(),codex_5h_used_percent:45}}),account({id:'3',name:'Disabled',status:'disabled'})]});
 });
 const r=await app(new Request('https://edge/functions/v1/sub2api/v1/usage?key='+key));
 assert.equal(r.status,200);assert.equal(r.headers.get('referrer-policy'),'no-referrer');
 const body=await r.json();assert.deepEqual(body.accounts.map(a=>a.account_name),['First','Second']);
 assert.deepEqual(body.accounts.map(a=>a.five_hour.used_percent),[12,45]);
});
test('usage URL rejects malformed and conflicting credentials and inference routes reject query keys',async()=>{
 const app=handler(()=>assert.fail('invalid URL credentials must not query the database'));
 for(const key of ['', 'a'.repeat(513), 'sk-invalid%20key'])assert.equal((await app(new Request('https://edge/v1/usage?key='+key))).status,401);
 assert.equal((await app(new Request('https://edge/v1/usage?key=sk-usage-'+'a'.repeat(64),{headers:{authorization:'Bearer different'}}))).status,400);
 assert.equal((await app(new Request('https://edge/v1/responses?key=sk-usage-'+'a'.repeat(64),{method:'POST',body:'{}'}))).status,401);
});

test('mixed-provider groups route quota reads independently and expose only public windows', async () => {
  const seen = [], saves = [];
  const providerAccounts = ['anthropic', 'antigravity', 'gemini', 'grok'].map((platform, i) => account({
    id: String(i + 100), platform, quota_snapshot: {}, usage_snapshot: { fetched_at: now, windows: [{ id: 'cached', used_percent: 99 }] },
    credentials: { access_token: 'provider-secret', expires_at: Date.now() + 3600_000, project_id: 'private-project' },
  }));
  const app = handler((url, init, args) => {
    if (url.pathname.endsWith('/s2a_personal_usage_accounts')) return Response.json({ accounts: providerAccounts });
    if (url.pathname.endsWith('/s2a_personal_usage_save')) { saves.push(args); return Response.json(true); }
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer provider-secret');
    seen.push(url.href);
    if (url.hostname === 'api.anthropic.com') {
      assert.equal(new Headers(init.headers).get('anthropic-beta'), 'oauth-2025-04-20');
      assert.equal(new Headers(init.headers).get('user-agent'), 'claude-code/2.1.7');
      return Response.json({ five_hour: { utilization: 21, resets_at: new Date((now + 1000) * 1000).toISOString() }, seven_day_sonnet: { utilization: 65 }, secret: 'never-return' });
    }
    if (url.pathname.endsWith('fetchAvailableModels')) {
      assert.equal(init.method, 'POST'); assert.equal(args.project, 'private-project');
      return Response.json({ models: { 'claude-model': { quotaInfo: { remainingFraction: 0.25, resetTime: new Date((now + 5000) * 1000).toISOString() }, private: 'never-return' } } });
    }
    if (url.pathname.endsWith('retrieveUserQuota')) return Response.json({ buckets: [{ modelId: 'gemini-model', remainingFraction: 0.5, resetTime: new Date((now + 1000) * 1000).toISOString(), private: 'never-return' }] });
    assert.equal(url.hostname, 'cli-chat-proxy.grok.com');
    assert.equal(new Headers(init.headers).get('x-xai-token-auth'), 'xai-grok-cli');
    return Response.json({ config: url.search ? { creditUsagePercent: 42, currentPeriod: { type: 'weekly', end: new Date((now + 2000) * 1000).toISOString() } } : { monthlyLimit: { val: '10000' }, used: { val: '2000' }, billingPeriodEnd: new Date((now + 80000) * 1000).toISOString() } });
  });
  const response = await app(request('?refresh=true'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.accounts.map(a => a.platform), ['anthropic', 'antigravity', 'gemini', 'grok']);
  assert.ok(body.accounts.every(a => a.supported && !a.cached && !a.stale));
  assert.equal(body.accounts[0].five_hour.used_percent, 21);
  assert.equal(body.accounts[0].seven_day, null);
  assert.equal(body.accounts[1].windows[0].used_percent, 75);
  assert.equal(body.accounts[1].windows[0].window_seconds, null);
  assert.equal(body.accounts[2].windows[0].model, 'gemini-model');
  assert.equal(body.accounts[3].seven_day.used_percent, 42);
  assert.equal(body.accounts[3].windows.find(w => w.id === 'monthly').used_percent, 20);
  assert.equal(seen.length, 5); assert.equal(saves.length, 4);
  for (const secret of ['provider-secret', 'private-project', 'never-return']) assert.equal(JSON.stringify(body).includes(secret), false);
});

test('provider cache lasts one minute, sanitizes payloads, and retains stale values on upstream failure', async () => {
  const windows = [{ id: 'five_hour', used_percent: 30, remaining_percent: 999, window_seconds: 18000,
    reset_at: new Date((now + 1000) * 1000).toISOString(), secret: 'never-return' }];
  for (const expired of [false, true]) {
    let reads = 0;
    const app = handler(url => {
      if (url.pathname.endsWith('/s2a_personal_usage_accounts')) return Response.json({ accounts: [account({ platform: 'anthropic', usage_snapshot: { fetched_at: now - (expired ? 61 : 0), windows } })] });
      reads++; return new Response('private failure', { status: 403 });
    });
    const body = await (await app(request())).json(), a = body.accounts[0];
    assert.equal(reads, expired ? 1 : 0); assert.equal(a.stale, expired); assert.equal(a.cached, true);
    assert.equal(a.five_hour.remaining_percent, 70);
    assert.equal(a.error, expired ? 'quota_upstream_error' : undefined);
    assert.equal(JSON.stringify(body).includes('never-return'), false);
    assert.equal(JSON.stringify(body).includes('private failure'), false);
  }
});

test('unsupported credential types are listed without querying or fabricating quota', async () => {
  const app = handler(url => {
    assert.ok(url.pathname.endsWith('/s2a_personal_usage_accounts'));
    return Response.json({ accounts: [account({ platform: 'anthropic', type: 'apikey' }), account({ id: '43', platform: 'typesafe', type: 'apikey' })] });
  });
  const { accounts } = await (await app(request('?refresh=true'))).json();
  assert.equal(accounts.length, 2);
  for (const a of accounts) { assert.equal(a.supported, false); assert.deepEqual(a.windows, []); assert.equal(a.five_hour, null); assert.equal(a.seven_day, null); assert.equal(a.error, 'quota_not_supported'); }
});

test('invalid or missing provider quota is unknown, never zero utilization', async () => {
  for (const [platform, payload] of [['anthropic', { five_hour: {} }], ['antigravity', { models: { x: { quotaInfo: {} } } }], ['gemini', { buckets: [{ remainingFraction: 2 }] }], ['grok', { config: {} }]]) {
    const app = handler(url => url.pathname.endsWith('/s2a_personal_usage_accounts') ? Response.json({ accounts: [account({ platform, credentials: { access_token: 'provider-secret', expires_at: Date.now() + 3600000, project_id: 'project' } })] }) : Response.json(payload));
    const a = (await (await app(request())).json()).accounts[0];
    assert.equal(a.stale, true); assert.equal(a.error, 'quota_unavailable'); assert.deepEqual(a.windows, []);
  }
});

test('Gemini AI Studio OAuth reports unsupported subscription quota without contacting Code Assist', async () => {
  const app = handler(url => {
    assert.ok(url.pathname.endsWith('/s2a_personal_usage_accounts'));
    return Response.json({ accounts: [account({ platform: 'gemini', credentials: { access_token: 'provider-secret', oauth_type: 'ai_studio', expires_at: Date.now() + 3600000 } })] });
  });
  const a = (await (await app(request('?refresh=true'))).json()).accounts[0];
  assert.equal(a.supported, false); assert.equal(a.stale, false); assert.equal(a.error, 'quota_not_supported'); assert.deepEqual(a.windows, []);
});


test('browser URLs accept the authorized inference key on short and versioned usage paths', async () => {
  const key = 'sk-s2a-' + 'a'.repeat(64);
  let reads = 0;
  const app = handler(async (url, init, args) => {
    assert.ok(url.pathname.endsWith('/s2a_personal_usage_accounts'));
    assert.equal(args.p_key_hash, await hashKey(key)); reads++;
    return Response.json({ accounts: [account()] });
  });
  for (const path of ['/usage', '/v1/usage']) {
    const response = await app(new Request('https://edge/functions/v1/sub2api' + path + '?key=' + key));
    assert.equal(response.status, 200); assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const body = await response.json(); assert.equal(body.accounts.length, 1); assert.equal(JSON.stringify(body).includes(key), false);
  }
  assert.equal(reads, 2);
});

test('browser key access retains database authorization failures', async () => {
  for (const [error, status] of [['invalid_api_key', 401], ['group_forbidden', 403], ['ip_forbidden', 403]]) {
    const app = handler(() => Response.json({ error, status }));
    const response = await app(new Request('https://edge/functions/v1/sub2api/usage?key=sk-' + 'a'.repeat(64)));
    assert.equal(response.status, status);
  }
});
