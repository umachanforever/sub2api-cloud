import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanAntigravitySchema as clean } from '../supabase/functions/sub2api/antigravity_schema.ts';
import { antigravityOAuthRequest } from '../supabase/functions/sub2api/antigravity_oauth.ts';

test('Antigravity expands definitions without dropping property names or mutating caller schemas', () => {
  const input = { type: 'object', $defs: { 'a/b': { type: 'string', minLength: 2 } }, properties: { type: { $ref: '#/$defs/a~1b' }, properties: { type: 'boolean' } }, required: ['type', 'absent'], additionalProperties: false };
  const snapshot = structuredClone(input), result = clean(input);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(result.required, ['type']);
  assert.equal(result.properties.type.type, 'string');
  assert.match(result.properties.type.description, /minLen: 2/);
  assert.equal(result.properties.properties.type, 'boolean');
  assert.equal(result.additionalProperties, undefined); assert.equal(result.$defs, undefined);
});
test('Antigravity combines object branches and translates nullable tuples and constants', () => {
  const result = clean({ allOf: [
    { type: 'object', properties: { fixed: { const: 'v', enum: ['v', 'other'] } }, required: ['fixed'] },
    { type: 'object', properties: { tuple: { type: 'ARRAY', prefixItems: [{ type: 'null' }, { type: ['integer', 'null'], minimum: 1 }], items: false } }, required: ['tuple'] },
  ] });
  assert.deepEqual(result.required, ['fixed', 'tuple']);
  assert.deepEqual(result.properties.fixed.enum, ['v']);
  assert.equal(result.properties.tuple.items.type, 'integer');
  assert.match(result.properties.tuple.items.description, /nullable/);
  assert.equal(result.properties.tuple.prefixItems, undefined);
});
test('Antigravity selects useful union branches and supplies required array and object shapes', () => {
  const result = clean({ type: 'object', properties: {
    union: { anyOf: [{ type: 'null' }, { type: 'object', properties: { x: { type: 'string' } } }] },
    array: { type: 'array', items: false }, empty: { type: 'object' }, value: { const: 7 },
  } });
  assert.equal(result.properties.union.properties.x.type, 'string');
  assert.deepEqual(result.properties.array.items, { type: 'string' });
  assert.deepEqual(result.properties.empty.required, ['reason']);
  assert.deepEqual(result.properties.value.enum, ['7']);
  assert.equal(result.properties.value.type, 'string');
});
test('Antigravity rejects unresolved, external, recursive, and excessively deep schemas', () => {
  for (const input of [
    { $ref: 'https://schema.test/tool' }, { $ref: '#/$defs/absent' },
    { $defs: { loop: { type: 'object', properties: { next: { $ref: '#/$defs/loop' } } } }, $ref: '#/$defs/loop' },
  ]) assert.throws(() => clean(input), { code: 'unsupported_tool_schema_reference' });
  let input = { type: 'string' };
  for (let i = 0; i < 70; i++) input = { type: 'array', items: input };
  assert.throws(() => clean(input), { code: 'invalid_tool_schema' });
});
test('Antigravity forwards cleaned declarations while retaining tools, instructions and signatures', () => {
  const body = { contents: [{ role: 'user', parts: [{ text: 'hi', thoughtSignature: 'signature' }] }], tools: [{ functionDeclarations: [{ name: 'lookup', parameters: { type: 'object', properties: { query: { type: 'string', pattern: '^x' } } } }] }, { googleSearch: {} }] };
  const snapshot = structuredClone(body);
  const outgoing = antigravityOAuthRequest({ access_token: 'private', project_id: 'project' }, 'gemini', '/v1beta/models/gemini-test:generateContent', body, new Request('https://edge.test'), new AbortController().signal);
  const forwarded = JSON.parse(outgoing.init.body).request;
  assert.deepEqual(body, snapshot);
  assert.match(forwarded.tools[0].functionDeclarations[0].parameters.properties.query.description, /pattern: \^x/);
  assert.deepEqual(forwarded.tools[1], { googleSearch: {} });
  assert.equal(forwarded.contents[0].parts[0].thoughtSignature, 'signature');
});
