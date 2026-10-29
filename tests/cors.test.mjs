import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandler } from './handler.mjs';
const config = { url: 'https://db.example', serviceKey: 'service', encryptionKey: 'unused', adminIds: [], dataModel: 'native' };

test('WebView model discovery preflight succeeds without a bearer or database call', async () => {
  const app = createHandler(config, () => assert.fail('preflight must not query database'));
  for (const origin of ['capacitor://localhost', 'http://localhost', 'https://web.chatboxai.app', 'null']) {
    const response = await app(new Request('https://edge/functions/v1/sub2api/v1/models', {
      method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,content-type,x-stainless-os' },
    }));
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.match(response.headers.get('access-control-allow-methods'), /GET/);
    assert.match(response.headers.get('access-control-allow-headers'), /authorization/);
    assert.match(response.headers.get('access-control-allow-headers'), /x-stainless-os/);
    assert.equal(response.headers.has('access-control-allow-credentials'), false);
  }
});

test('CORS does not bypass authentication and errors remain readable to WebViews', async () => {
  const app = createHandler(config, () => assert.fail('unauthenticated request must not query database'));
  const response = await app(new Request('https://edge/v1/models', { headers: { origin: 'capacitor://localhost' } }));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal((await response.json()).error.type, 'unauthorized');
});
