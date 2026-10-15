import assert from 'node:assert/strict';
import test from 'node:test';
import {request} from 'node:http';
import {createOAuthCallbackServer} from '../scripts/oauth-callback.mjs';

test('loopback callback page never reflects authorization secrets or attacker markup and disables caching/referrers',async()=>{
 const server=createOAuthCallbackServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const base='http://127.0.0.1:'+server.address().port;
  const response=await fetch(base+'/auth/callback?code=private-code<script>&state=private-state');
  assert.equal(response.status,200);const body=await response.text();assert.equal(body.includes('private-code'),false);assert.equal(body.includes('private-state'),false);assert.equal(body.includes('<script>'),false);
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  assert.match(response.headers.get('content-security-policy'),/default-src 'none'/);
  assert.equal((await fetch(base+'/auth/callback?error=denied')).status,400);
  assert.equal((await fetch(base+'/other')).status,404);
  for (const host of ['evil.example','evil@localhost','%']) {
    const status = await new Promise((resolve,reject) => {
      const r=request(base+'/auth/callback?code=x&state=y',{headers:{host}},response=>{response.resume();resolve(response.statusCode);});
      r.on('error',reject);r.end();
    });
    assert.equal(status,404);
  }
 }finally {await new Promise(resolve=>server.close(resolve));}
});
