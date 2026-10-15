import test from 'node:test';
import assert from 'node:assert/strict';
import { antigravityOAuthRequest } from '../supabase/functions/sub2api/antigravity_oauth.ts';
import { antigravityToClaude } from '../supabase/functions/sub2api/antigravity_claude.ts';
import { proxy } from '../supabase/functions/sub2api/proxy.ts';
const input = { model: 'claude-test', messages: [{ role: 'user', content: 'Find a source' }], max_tokens: 1024 };
const credentials = { access_token: 'private-token', project_id: 'private-project' };
function envelope(tools) {
  const outgoing = antigravityOAuthRequest(credentials, 'messages', '/v1/messages', { ...input, tools }, new Request('https://edge.test'), new AbortController().signal);
  return { ...JSON.parse(outgoing.init.body), outgoing };
}
const search = { type: 'web_search_20250305', name: 'web_search' };
const code = { type: 'code_execution', name: 'code_execution' };
const custom = { name: 'lookup', input_schema: { type: 'object', properties: { query: { type: 'string' } } } };
test('Antigravity search-only requests use the original fallback model and request type', () => {
  for (const tool of [search, { type: 'google_search' }, { name: 'web_search' }]) {
    const value = envelope([tool]);
    assert.equal(value.model, 'gemini-2.5-flash'); assert.equal(value.requestType, 'web_search');
    assert.equal(value.outgoing.upstreamModel, 'gemini-2.5-flash'); assert.equal(value.outgoing.claudeModel, 'claude-test');
    assert.equal(value.request.tools[0].googleSearch.enhancedContent.imageSearch.maxResultCount, 5);
  }
});
test('Antigravity preserves function tools and model when built-ins are mixed in', () => {
  const value = envelope([search, code, custom]);
  assert.equal(value.model, 'claude-test'); assert.equal(value.requestType, 'agent');
  assert.equal(value.request.tools.length, 1); assert.equal(value.request.tools[0].functionDeclarations[0].name, 'lookup');
  const standalone = envelope([code]);
  assert.equal(standalone.model, 'claude-test'); assert.deepEqual(standalone.request.tools, [{ codeExecution: {} }]);
});
const grounding = { webSearchQueries: ['public query'], groundingChunks: [
  { web: { title: 'Public source', uri: 'https://example.com/article' } },
  { web: { title: 'Unsafe', uri: 'javascript:alert(1)' } },
  { web: { title: 'Private URL', uri: 'https://user:secret@example.com/' } },
], privateTrace: 'private-trace' };
const value = { candidates: [{ content: { parts: [{ text: 'Answer' }, { executableCode: { language: 'PYTHON', code: 'print(2)' } }, { codeExecutionResult: { outcome: 'OUTCOME_OK', output: '2' } }] }, groundingMetadata: grounding, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4 } };
for (const streaming of [false, true]) test(`Antigravity ${streaming ? 'SSE' : 'JSON'} preserves code and safe search sources`, async () => {
  const response = streaming ? new Response('data: ' + JSON.stringify(value) + '\n\n', { headers: { 'content-type': 'text/event-stream' } }) : Response.json(value);
  const result = await antigravityToClaude(response, streaming, 'claude-test');
  const text = await result.text();
  assert.match(text, /print\(2\)/); assert.match(text, /Execution result/); assert.match(text, /https:\/\/example.com\/article/);
  assert.match(text, /public query/); assert.doesNotMatch(text, /javascript:|user:secret|private-trace/);
  if (streaming) assert.ok(text.indexOf('Sources:') < text.indexOf('event: message_delta'));
});
test('Antigravity search proxy records the actual fallback model and retains the public model alias', async () => {
  const finishes = [];
  const db = { config: { dataModel: 'native' }, async rpc(name, args) {
    if (name === 's2a_personal_acquire') return { lease_id: 'lease', account: { id: '1', platform: 'antigravity', type: 'oauth', credential_storage: 'vault', credential_version: 1, credentials: { ...credentials, expires_at: Date.now() + 3600000 } } };
    if (name === 's2a_personal_finish') { finishes.push(args); return; }
    if (name === 's2a_personal_ops_error_record') return;
    assert.fail(name);
  }, async fetchImpl(url, init) {
    const forwarded = JSON.parse(init.body);
    assert.equal(forwarded.model, 'gemini-2.5-flash'); assert.equal(forwarded.requestType, 'web_search');
    return new Response('data: ' + JSON.stringify({ response: value }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } };
  const request = new Request('https://edge.test/v1/messages', { method: 'POST', body: JSON.stringify({ ...input, tools: [search] }) });
  const response = await proxy(request, '/v1/messages', 'sk-client', db, { requestId: crypto.randomUUID(), started: Date.now() });
  const result = await response.json();
  assert.equal(result.model, 'claude-test'); assert.equal(finishes.length, 1);
  assert.equal(finishes[0].p_upstream_model, 'gemini-2.5-flash'); assert.equal(finishes[0].p_input_tokens, 5); assert.equal(finishes[0].p_output_tokens, 4);
});

test('Antigravity SSE retains late grounding metadata and emits sources once before completion', async () => {
  const events = [
    { candidates: [{ content: { parts: [{ text: 'Answer' }] }, finishReason: 'STOP' }] },
    { candidates: [{ groundingMetadata: grounding }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4 } },
    { candidates: [{ groundingMetadata: grounding }] },
  ];
  const response = new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
  const result = await antigravityToClaude(response, true, 'alias'); const text = await result.text();
  assert.equal(text.split('Sources:').length, 2);
  assert.ok(text.indexOf('Sources:') < text.indexOf('event: message_delta'));
  assert.match(text, /"output_tokens":4/);
});
