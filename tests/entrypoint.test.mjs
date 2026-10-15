import test from 'node:test';
import assert from 'node:assert/strict';

test('Cloud entrypoint uses native admission when the data-model setting is absent', async () => {
  const previousDeno = globalThis.Deno, previousFetch = globalThis.fetch;
  const values = { SUPABASE_URL: 'https://database.invalid', SUPABASE_SERVICE_ROLE_KEY: 'private', GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64: Buffer.alloc(32, 7).toString('base64') };
  let handler; const calls = [];
  globalThis.Deno = { env: { get: key => values[key], toObject: () => ({ ...values }) }, serve: value => { handler = value; } };
  globalThis.fetch = async url => {
    calls.push(String(url));
    return Response.json({ error: 'no_available_account', status: 503 });
  };
  try {
    await import('../supabase/functions/sub2api/index.ts');
    assert.equal(typeof handler, 'function');
    const response = await handler(new Request('https://gateway.invalid/v1/models', { headers: { authorization: 'Bearer sk-fixture' } }));
    assert.equal(response.status, 503);
    assert.ok(calls.some(url => url.endsWith('/rpc/s2a_personal_acquire')));
    assert.equal(calls.some(url => url.endsWith('/rpc/s2a_acquire')), false);
  } finally { globalThis.Deno = previousDeno; globalThis.fetch = previousFetch; }
});
