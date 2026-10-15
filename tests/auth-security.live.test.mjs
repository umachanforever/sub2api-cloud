import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test from 'node:test';

// Opt-in: creates one temporary confirmed Auth user and always deletes it.
test('native Supabase TOTP enrollment, AAL enforcement, step-up and removal', {
  skip: process.env.S2A_AUTH_TEST !== '1', timeout: 180_000,
}, async () => {
  const base = process.env.SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const publicKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  assert.ok(base && service && publicKey, 'Supabase configuration required');
  const email = `mfa-test-${randomUUID()}@example.com`;
  const password = `${randomUUID()}Aa1!`;
  async function request(path, { token = service, key = service, method = 'GET', body, status = 200 } = {}) {
    const response = await fetch(`${base}${path}`, {
      method, headers: { apikey: key, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
    });
    assert.equal(response.status, status, `${method} ${path}: unexpected status`);
    if (status === 204) return;
    const value = await response.json();
    return value.data ?? value;
  }
  const user = await request('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  try {
    const login = () => request('/auth/v1/token?grant_type=password', { key: publicKey, token: publicKey, method: 'POST', body: { email, password } });
    const edge = (operation, token, body, status = 200) => request(`/functions/v1/subscription-api/api/v1/user/totp/${operation}`, {
      token, key: publicKey, method: body === undefined ? 'GET' : 'POST', body, status,
    });
    const profile = (token, status) => request('/functions/v1/subscription-api/api/v1/auth/me', { token, key: publicKey, status });
    const initial = await login();
    const setup = await edge('setup', initial.access_token, { password });
    assert.match(setup.qr_code_url, /^otpauth:\/\/totp\//);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const letter of setup.secret.replace(/=+$/, '').toUpperCase()) {
      const index = alphabet.indexOf(letter);
      assert.ok(index >= 0, 'invalid native base32 secret');
      bits += index.toString(2).padStart(5, '0');
    }
    const key = Buffer.from(bits.match(/.{8}/g).map(byte => parseInt(byte, 2)));
    const totp = () => {
      const counter = Buffer.alloc(8);
      counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
      const digest = createHmac('sha1', key).update(counter).digest();
      const offset = digest.at(-1) & 15;
      return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
    };
    const nextCode = async () => {
      await new Promise(resolve => setTimeout(resolve, 30_000 - Date.now() % 30_000 + 1000));
      return totp();
    };
    const enabled = await edge('enable', initial.access_token, { setup_token: setup.setup_token, totp_code: totp() });
    assert.equal(JSON.parse(Buffer.from(enabled.access_token.split('.')[1], 'base64url')).aal, 'aal2');
    await profile(enabled.access_token, 200);
    const lower = await login();
    await profile(lower.access_token, 403);
    assert.equal((await edge('status', lower.access_token)).enabled, true);
    const raised = await edge('step-up', lower.access_token, { code: await nextCode() });
    await profile(raised.access_token, 200);
    const disabled = await edge('disable', raised.access_token, { password, totp_code: await nextCode() });
    assert.equal((await edge('status', disabled.access_token)).enabled, false);
    await profile((await login()).access_token, 200);
    const audit = async (field, id) => request(`/rest/v1/s2a_audit_logs?${new URLSearchParams({ [field]: `eq.${id}`, select: 'action,actor_user_id,actor_role,auth_method,extra' })}`);
    const events = await audit('extra->>resource_id', user.id);
    assert.ok(events.some(event => event.action === 'auth.users.insert'));
    assert.ok(events.some(event => event.action === 'auth.users.update'));
    const factors = await audit('extra->resource_refs->>user_id', user.id);
    for (const action of ['auth.mfa_factors.insert', 'auth.mfa_factors.update', 'auth.mfa_factors.delete']) assert.ok(factors.some(event => event.action === action), action);
    for (const event of [...events, ...factors]) {
      assert.equal(event.actor_user_id, null);
      assert.equal(event.actor_role, 'system');
      assert.equal(event.auth_method, 'supabase-auth');
    }
    const serialized = JSON.stringify([...events, ...factors]);
    assert.ok(!serialized.includes(password));
    assert.ok(!serialized.includes(setup.secret));
    assert.ok(!serialized.includes(initial.access_token));
  } finally {
    await request(`/auth/v1/admin/users/${user.id}`, { method: 'DELETE' });
  }
});
