import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyCloud } from '../scripts/verify-cloud.mjs';

const config = { base_url: 'https://cloud.test/functions/v1/subscription-api/v1', api_key: 'sk-test', model: 'model-test' };
function fixture({ terminal = true, unauthorized = 401 } = {}) {
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
    if (!JSON.parse(init.body).stream) return Response.json({ choices: [{ message: { content: 'OK' } }] });
    const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: {"choices":[{"finish_reason":"stop"}]}\n\n' + (terminal ? 'data: [DONE]\n\n' : ''));
    return new Response(new ReadableStream({ start(controller) {
      // Exercise split UTF-8, data fields, and event boundaries.
      for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.slice(offset, offset + 3));
      controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  };
}
test('cloud verification checks real client paths without requiring a local console', async () => {
  assert.deepEqual(await verifyCloud(config, fixture()), ['health', 'authentication', 'models', 'chat', 'stream', 'usage']);
});
test('cloud verification rejects incomplete streams and publicly accessible catalogs', async () => {
  await assert.rejects(verifyCloud(config, fixture({ terminal: false })), /terminal event/);
  await assert.rejects(verifyCloud(config, fixture({ unauthorized: 200 })), /must return 401/);
});
test('cloud verification rejects credentials in URLs before any request', async () => {
  await assert.rejects(verifyCloud({ ...config, base_url: 'https://secret@cloud.test/v1' }, () => assert.fail()), /without credentials/);
});
