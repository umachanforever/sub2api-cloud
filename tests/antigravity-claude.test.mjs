import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeToAntigravity, antigravityToClaude } from '../supabase/functions/subscription-api/antigravity_claude.ts';
import { proxy } from '../supabase/functions/subscription-api/proxy.ts';

const body = { model: 'claude-test', system: [{ type: 'text', text: 'Keep instructions' }], max_tokens: 1200, messages: [
  { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] },
  { role: 'assistant', content: [{ type: 'thinking', thinking: 'plan', signature: 'signed-thinking' }, { type: 'tool_use', id: 'tool-1', name: 'lookup', input: { query: 'hi' }, signature: 'signed-tool' }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: 'result' }] }] },
], tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object', properties: { query: { const: 'hi' } } } }], tool_choice: { type: 'tool', name: 'lookup' }, thinking: { type: 'enabled', budget_tokens: 1500 } };
const events = [
  { candidates: [{ content: { parts: [{ text: 'plan', thought: true }] } }], usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 4 } },
  { candidates: [{ content: { parts: [{ text: 'more', thought: true, thoughtSignature: 'thinking-signature' }, { text: '你好' }] } }] },
  { candidates: [{ content: { parts: [{ functionCall: { id: 'call-1', name: 'lookup', args: { query: 'hi' } }, thoughtSignature: 'tool-signature' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 4, candidatesTokenCount: 3, thoughtsTokenCount: 2 } },
];
function stream(values, wrap = false) {
  const bytes = new TextEncoder().encode(values.map(value => 'data: ' + JSON.stringify(wrap ? { response: value } : value) + '\n\n').join(''));
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) { if (offset === bytes.length) controller.close(); else { controller.enqueue(bytes.slice(offset, offset + 7)); offset = Math.min(bytes.length, offset + 7); } } }), { headers: { 'content-type': 'text/event-stream' } });
}
function frames(text) { return text.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.split('\n').find(line => line.startsWith('data:')).slice(5))); }

test('Claude Antigravity conversion retains instructions, images, signed tools and named results', () => {
  const snapshot = structuredClone(body), converted = claudeToAntigravity(body);
  assert.deepEqual(body, snapshot);
  assert.equal(converted.systemInstruction.parts[0].text, 'Keep instructions');
  assert.equal(converted.contents[0].parts[1].inlineData.mimeType, 'image/png');
  assert.equal(converted.contents[1].parts[0].thoughtSignature, 'signed-thinking');
  assert.equal(converted.contents[1].parts[1].thoughtSignature, 'signed-tool');
  assert.equal(converted.contents[2].parts[0].functionResponse.name, 'lookup');
  assert.equal(converted.contents[2].parts[0].functionResponse.response.result, 'result');
  assert.deepEqual(converted.toolConfig.functionCallingConfig, { mode: 'ANY', allowedFunctionNames: ['lookup'] });
  assert.equal(converted.generationConfig.maxOutputTokens, 1501);
});
test('Unsigned Claude thinking is downgraded; Gemini-only dummy signatures remain provider-specific', () => {
  const input = structuredClone(body); delete input.messages[1].content[0].signature;
  assert.equal(claudeToAntigravity(input).generationConfig.thinkingConfig, undefined);
  input.model = 'gemini-test';
  assert.equal(claudeToAntigravity(input).contents[1].parts[0].thoughtSignature, 'skip_thought_signature_validator');
  input.messages[0].content.push({ type: 'audio' });
  assert.throws(() => claudeToAntigravity(input), { code: 'unsupported_messages_content' });
});
test('Claude JSON output merges thinking fragments and retains tool signatures and raw usage', async () => {
  const response = await antigravityToClaude(Response.json({ candidates: [{ content: { parts: events.flatMap(value => value.candidates[0].content.parts) }, finishReason: 'STOP' }], usageMetadata: events.at(-1).usageMetadata }), false, 'alias');
  const value = await response.json();
  assert.equal(value.model, 'alias'); assert.equal(value.stop_reason, 'tool_use');
  assert.deepEqual(value.content[0], { type: 'thinking', thinking: 'planmore', signature: 'thinking-signature' });
  assert.equal(value.content[2].signature, 'tool-signature');
  assert.deepEqual(value.usage, { input_tokens: 6, output_tokens: 5, cache_read_input_tokens: 4 });
});
test('Claude SSE maintains block indices, terminal ordering, signatures and split UTF-8', async () => {
  const response = await antigravityToClaude(stream(events), true, 'alias');
  const values = frames(await response.text());
  assert.equal(values[0].type, 'message_start'); assert.equal(values.at(-1).type, 'message_stop');
  const starts = values.filter(value => value.type === 'content_block_start');
  assert.deepEqual(starts.map(value => value.index), [0, 1, 2]);
  assert.deepEqual(starts.map(value => value.content_block.type), ['thinking', 'text', 'tool_use']);
  assert.equal(starts[2].content_block.signature, 'tool-signature');
  assert.equal(values.find(value => value.delta?.type === 'signature_delta').delta.signature, 'thinking-signature');
  assert.equal(values.find(value => value.delta?.type === 'text_delta').delta.text, '你好');
  assert.equal(values.at(-2).delta.stop_reason, 'tool_use'); assert.equal(values.at(-2).usage.output_tokens, 5);
});
test('Claude SSE rejects truncation without manufacturing message_stop', async () => {
  const response = await antigravityToClaude(stream(events.slice(0, 1)), true, 'alias');
  await assert.rejects(response.text(), /incomplete_upstream_response/);
});
for (const streaming of [false, true]) test(`Antigravity Messages ${streaming ? 'SSE' : 'JSON'} proxy records canonical usage`, async () => {
  const finished = [], calls = [];
  const db = { config: { dataModel: 'native' }, async rpc(name, args) {
    if (name === 's2a_personal_acquire') return { lease_id: 'lease', upstream_model: 'claude-upstream', account: { id: '1', platform: 'antigravity', type: 'oauth', credential_storage: 'vault', credential_version: 1, credentials: { access_token: 'private-token', project_id: 'private-project', expires_at: Date.now() + 3600000 } } };
    if (name === 's2a_personal_finish') { finished.push(args); return; }
    if (name === 's2a_personal_ops_error_record') return;
    assert.fail(name);
  }, async fetchImpl(url, init) {
    calls.push(url); const value = JSON.parse(init.body);
    assert.equal(value.model, 'claude-upstream');
    assert.match(value.request.sessionId, /^-[0-9]+$/);
    assert.match(value.request.systemInstruction.parts[0].text, /You are Antigravity/);
    assert.deepEqual(value.request.tools[0].functionDeclarations[0].parameters.properties.query.enum, ['hi']);
    assert.equal(value.request.tools[0].functionDeclarations[0].parameters.properties.query.const, undefined);
    return stream(events, true);
  } };
  const request = new Request('https://edge.test/v1/messages', { method: 'POST', body: JSON.stringify({ ...body, stream: streaming }) });
  const response = await proxy(request, '/v1/messages', 'sk-client', db, { requestId: crypto.randomUUID(), started: Date.now() });
  assert.equal(response.status, 200); const text = await response.text();
  assert.match(text, /tool_use/); assert.match(text, /"model":"claude-test"/); assert.doesNotMatch(text, /private-token|private-project/);
  assert.equal(calls.length, 1); assert.equal(finished.length, 1);
  assert.equal(finished[0].p_input_tokens, 10); assert.equal(finished[0].p_output_tokens, 5); assert.equal(finished[0].p_cache_read_tokens, 4);
});

test('Antigravity prefixed routes preserve native authentication and reject other providers', async () => {
  const { createHandler } = await import('../supabase/functions/subscription-api/app.ts');
  const { hashKey } = await import('../supabase/functions/subscription-api/validation.ts');
  const finishes = [];
  const handler = createHandler({ url: 'https://db.test', serviceKey: 'service', encryptionKey: '', adminIds: [], dataModel: 'native' }, async (url, init) => {
    const name = new URL(url).pathname.split('/').at(-1), args = JSON.parse(init.body);
    if (name === 's2a_personal_acquire') {
      assert.equal(args.p_key_hash, await hashKey('sk-client'));
      return Response.json({ lease_id: 'lease', account: { id: '1', platform: 'openai', type: 'oauth' } });
    }
    if (name === 's2a_personal_finish') finishes.push(args);
    else assert.ok(['s2a_log_write', 's2a_personal_ops_error_record'].includes(name), name);
    return Response.json(null);
  });
  const url = 'https://edge.test/functions/v1/sub2api/antigravity/v1/messages';
  const missing = await handler(new Request(url, { method: 'POST', body: JSON.stringify(body) }));
  assert.equal(missing.status, 401);
  const response = await handler(new Request(url, { method: 'POST', headers: { 'x-api-key': 'sk-client' }, body: JSON.stringify(body) }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.type, 'provider_route_mismatch');
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].p_status, 400);
});

test('Antigravity Messages keeps unknown usage absent and reports output limits', async () => {
  const response = await antigravityToClaude(Response.json({ candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }] }), false, 'alias');
  const value = await response.json();
  assert.deepEqual(value.usage, {}); assert.equal(value.stop_reason, 'max_tokens');
});
test('Antigravity custom tool schemas use the original nested specification', () => {
  const input = structuredClone(body);
  input.tools = [{ type: 'custom', name: 'lookup', custom: { description: 'Nested tool', input_schema: { type: 'object', properties: { input: { type: 'string' } } } } }];
  assert.equal(claudeToAntigravity(input).tools[0].functionDeclarations[0].description, 'Nested tool');
  input.tools = [{ type: 'unsupported_tool', name: 'unsupported' }];
  assert.throws(() => claudeToAntigravity(input), { code: 'unsupported_messages_tool' });
});
