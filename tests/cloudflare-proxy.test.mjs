import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../deploy/cloudflare/worker.mjs';

const env = { SUPABASE_URL: 'https://project.supabase.co' };

test('Cloudflare proxy preserves API paths, query parameters, authentication and streamed bodies without caching', async t => {
  for (const path of ['/v1/models', '/v1beta/models?key=test-key', '/functions/v1/sub2api/v1/models', '/usage?key=test-key']) {
    const mock = t.mock.method(globalThis, 'fetch', async (request, options) => {
      const target = new URL(request.url);
      assert.equal(target.origin, env.SUPABASE_URL);
      assert.equal(target.pathname, path.startsWith('/functions/') ? path : '/functions/v1/sub2api' + path.split('?')[0]);
      assert.equal(target.search, new URL('https://api.example.com' + path).search);
      assert.equal(request.headers.get('authorization'), 'Bearer test-key');
      assert.equal(request.headers.get('x-goog-api-key'), 'test-key');
      assert.equal(request.headers.get('host'), null);
      assert.equal(options.redirect, 'manual');
      assert.deepEqual(options.cf, { cacheTtl: 0, cacheEverything: false });
      return new Response('data: hello\n\n', { headers: { 'content-type': 'text/event-stream', 'cache-control': 'public, max-age=3600' } });
    });
    const response = await worker.fetch(new Request('https://api.example.com' + path, { headers: { authorization: 'Bearer test-key', 'x-goog-api-key': 'test-key', host: 'api.example.com' } }), env);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.equal(await response.text(), 'data: hello\n\n');
    mock.mock.restore();
  }
});

test('Cloudflare proxy forwards POST and cancellation and preserves upstream authentication errors', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async request => {
    assert.equal(request.method, 'POST');
    assert.deepEqual(await request.json(), { model: 'gemini-3-flash', stream: true });
    controller.abort();
    assert.equal(request.signal.aborted, true);
    return Response.json({ error: { code: 'unauthorized' } }, { status: 401 });
  });
  const response = await worker.fetch(new Request('https://api.example.com/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'gemini-3-flash', stream: true }), signal: controller.signal }), env);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: { code: 'unauthorized' } });
});

test('Cloudflare proxy rejects arbitrary origins and returns a bounded network error', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('private network detail'); });
  for (const origin of ['', 'https://example.com', 'http://project.supabase.co', 'https://project.supabase.co/path']) {
    assert.equal((await worker.fetch(new Request('https://api.example.com/health'), { SUPABASE_URL: origin })).status, 503);
  }
  assert.equal(calls, 0);
  const response = await worker.fetch(new Request('https://api.example.com/health'), env);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'proxy_upstream_unavailable' });
});

test('Cloudflare proxy delivers the first SSE chunk before the upstream closes', async t => {
  let source;
  const stream = new ReadableStream({ start(controller) { source = controller; } });
  t.mock.method(globalThis, 'fetch', async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
  const response = await worker.fetch(new Request('https://api.example.com/v1/chat/completions'), env);
  const reader = response.body.getReader();
  source.enqueue(new TextEncoder().encode('data: first\n\n'));
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
  source.close();
  assert.equal((await reader.read()).done, true);
});
