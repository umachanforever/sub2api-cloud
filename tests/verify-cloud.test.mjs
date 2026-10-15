import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyCloud } from '../scripts/verify-cloud.mjs';

const config = { base_url: 'https://cloud.test/functions/v1/sub2api/v1', api_key: 'sk-test', model: 'model-test' };
function fixture({ terminal = true, unauthorized = 401, model = config.model, responseTerminal = true } = {}) {
  return async (url, init) => {
    assert.equal(init.redirect, 'error');
    if (url.endsWith('/health')) {
      assert.equal(init.headers.authorization, undefined);
      return Response.json({ ok: true });
    }
    if (!init.headers.authorization) return new Response(null, { status: unauthorized });
    assert.equal(init.headers.authorization, 'Bearer sk-test');
    if (url.endsWith('/models')) return Response.json({ data: [{ id: config.model }] });
    if (url.endsWith('/usage')) return Response.json({ accounts: [] });
    assert.equal(JSON.parse(init.body).model, config.model);
    if (url.endsWith('/responses')) {
      const response = { model, status: 'completed', output: [{ content: [{ type: 'output_text', text: 'OK' }] }] };
      if (!JSON.parse(init.body).stream) return Response.json(response);
      return new Response('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'OK' }) + '\n\n' + (responseTerminal ? 'data: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (!JSON.parse(init.body).stream) return Response.json({ model, choices: [{ message: { content: 'OK' } }] });
    const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: {"choices":[{"finish_reason":"stop"}]}\n\n' + (terminal ? 'data: [DONE]\n\n' : ''));
    return new Response(new ReadableStream({ start(controller) {
      // Exercise split UTF-8, data fields, and event boundaries.
      for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.slice(offset, offset + 3));
      controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  };
}
test('cloud verification checks real client paths without requiring a local console', async () => {
  assert.deepEqual(await verifyCloud(config, fixture()), ['health', 'authentication', 'models', 'responses', 'chat', 'stream', 'responses-stream', 'usage']);
});
test('cloud verification rejects incomplete streams and publicly accessible catalogs', async () => {
  await assert.rejects(verifyCloud(config, fixture({ terminal: false })), /terminal event/);
  await assert.rejects(verifyCloud(config, fixture({ unauthorized: 200 })), /must return 401/);
});
test('cloud verification rejects credentials in URLs before any request', async () => {
  await assert.rejects(verifyCloud({ ...config, base_url: 'https://secret@cloud.test/v1' }, () => assert.fail()), /without credentials/);
});

test('cloud verification rejects model substitution and truncated Responses streams', async () => {
  await assert.rejects(verifyCloud(config, fixture({ model: 'other-model' })), /Returned model/);
  await assert.rejects(verifyCloud(config, fixture({ responseTerminal: false })), /terminal event/);
});
