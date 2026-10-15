import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createHandler} from './handler.mjs';
import {jobSigningKey} from '../supabase/functions/subscription-api/job_signing.ts';

test('Codex cron requires a scoped ticket and synchronizes without provider credentials', async () => {
 const calls=[];
 const signingKey=await jobSigningKey(Buffer.alloc(32,7).toString('base64'));
 const app=createHandler({url:'https://db.test',serviceKey:'private',jobSigningKey:signingKey,encryptionKey:'',adminIds:[],dataModel:'native'},async(url,init)=>{
  calls.push(url);
  if(url.endsWith('/s2a_gateway_codex_settings'))return Response.json({synced:'0.160.0'});
  if(new URL(url).hostname==='api.github.com')return Response.json({tag_name:'rust-v0.162.1',draft:false,prerelease:false});
  assert.ok(url.endsWith('/s2a_gateway_codex_version_save'));
  assert.equal(JSON.parse(init.body).p_version,'0.162.1');return Response.json({version:'0.162.1'});
 });
 const endpoint='https://gateway/internal/jobs/codex';
 assert.equal((await app(new Request(endpoint,{method:'POST'}))).status,401);
 const ticket=scope=>{const data=`${Math.floor(Date.now()/1000)+60}:${crypto.randomUUID()}`;return data+':'+createHmac('sha256',signingKey).update(`s2a-${scope}:${data}`).digest('hex');};
 assert.equal((await app(new Request(endpoint,{method:'POST',headers:{'x-s2a-codex-job-token':ticket('privacy')}}))).status,401);
 assert.equal(calls.length,0);
 const response=await app(new Request(endpoint,{method:'POST',headers:{'x-s2a-codex-job-token':ticket('codex')}}));
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{version:'0.162.1',enabled:true});assert.equal(calls.length,3);
});

test('Codex cron respects the automatic update switch', async () => {
 const app=createHandler({url:'https://db.test',serviceKey:'private',encryptionKey:'',adminIds:[],dataModel:'native'},async url=>{
  assert.ok(url.endsWith('/s2a_gateway_codex_settings'));return Response.json({synced:'0.160.0',auto_sync:'false'});
 });
 const response=await app(new Request('https://gateway/internal/jobs/codex',{method:'POST',headers:{authorization:'Bearer private'}}));
 assert.deepEqual(await response.json(),{version:'0.160.0',enabled:false});
});


test('scheduled job keys are deterministic and separate from credential encryption material', async () => {
 const key=Buffer.alloc(32,7).toString('base64');
 const derived=await jobSigningKey(key);
 assert.match(derived,/^[0-9a-f]{64}$/);
 assert.equal(await jobSigningKey(key),derived);
 assert.notEqual(derived,Buffer.alloc(32,7).toString('hex'));
 assert.notEqual(await jobSigningKey(Buffer.alloc(32,8).toString('base64')),derived);
 await assert.rejects(jobSigningKey('bad'));
});
