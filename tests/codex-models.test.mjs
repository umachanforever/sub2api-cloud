import test from 'node:test';
import assert from 'node:assert/strict';
import { modernCodexModel, validateCodexReasoning } from '../supabase/functions/subscription-api/codex_models.ts';
import { allowsModel } from '../supabase/functions/subscription-api/model_policy.ts';
import { normalizeBody } from '../supabase/functions/subscription-api/gateway.ts';

test('modern Codex policy recognizes official spellings without admitting lookalikes', () => {
  for (const id of ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna']) {
    const policy = { enabled: true, models: [id] };
    for (const model of [id, 'openai/' + id + '-max', id.toUpperCase().replaceAll('-', '_'), id + '-openai-compact']) {
      assert.equal(modernCodexModel(model)?.id, id);
      assert.equal(allowsModel(policy, model), true, model);
    }
    for (const model of [id + 'itude', id + '-preview', id + '-max-extra', 'gpt-6.1']) {
      assert.equal(modernCodexModel(model), undefined);
      assert.equal(allowsModel(policy, model), false, model);
    }
  }
});

test('GPT-6.1 rejects explicit disabled reasoning across all request protocols', () => {
  for (const effort of ['none', 'minimal', ' NONE ']) {
    for (const field of [{ reasoning: { effort } }, { reasoning_effort: effort }, { output_config: { effort } }]) {
      assert.throws(() => validateCodexReasoning({ model: 'gpt-6.1-sol', ...field }), /requires reasoning/);
    }
  }
  for (const body of [{ model: 'gpt-6.1-sol-none' }, { model: 'openai/GPT_6.1_SOL_MINIMAL' }, { model: 'gpt-6.1-sol', thinking: { type: 'disabled' } }]) {
    assert.throws(() => validateCodexReasoning(body), /requires reasoning/);
  }
  for (const effort of [undefined, 'low', 'medium', 'high', 'xhigh', 'max']) {
    const body = normalizeBody({ model: 'gpt-6.1-sol', input: 'hello', reasoning: { effort } });
    assert.equal(body.model, 'gpt-6.1-sol');
    assert.equal(body.reasoning.effort, effort);
  }
  assert.doesNotThrow(() => validateCodexReasoning({ model: 'gpt-6-sol', reasoning_effort: 'none' }));
});

test('cloud rejects disabled GPT-6.1 reasoning before provider dispatch and settles its lease', async () => {
  const { createHandler } = await import('./handler.mjs');
  const { encryptCredentials } = await import('../supabase/functions/subscription-api/credential_store.ts');
  const actor = '11111111-1111-4111-8111-111111111111';
  const id = '22222222-2222-4222-8222-222222222222';
  const config = { url: 'https://db.example', serviceKey: 'service', encryptionKey: Buffer.alloc(32, 7).toString('base64'), adminIds: [actor] };
  const encrypted = await encryptCredentials({ access_token: 'secret' }, config.encryptionKey);
  let finished = 0;
  const handler = createHandler(config, async (url, init) => {
    if (String(url).endsWith('/auth/v1/user')) return Response.json({ id: actor });
    if (String(url).endsWith('/s2a_acquire')) return Response.json({ lease_id: id, account: { id, ...encrypted, type: 'oauth', platform: 'openai', credential_version: 1 } });
    if (String(url).endsWith('/s2a_finish')) { assert.equal(JSON.parse(init.body).p_status, 400); finished++; return Response.json(null); }
    assert.fail('Invalid reasoning must not contact provider');
  });
  for (const [path, body] of [
    ['/v1/responses', { input: 'hello', reasoning: { effort: 'none' } }],
    ['/v1/chat/completions', { messages: [{ role: 'user', content: 'hello' }], reasoning_effort: 'minimal' }],
    ['/v1/messages', { messages: [{ role: 'user', content: 'hello' }], max_tokens: 32, thinking: { type: 'disabled' } }],
  ]) {
    const response = await handler(new Request('https://gateway' + path, { method: 'POST', headers: { authorization: 'Bearer session', 'x-s2a-frontend': '1' }, body: JSON.stringify({ model: 'gpt-6.1-sol', ...body }) }));
    assert.equal(response.status, 400, path);
  }
  assert.equal(finished, 3);
});
