import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createBackendHandler} from './handler.mjs';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
const config={url:'https://database.invalid',serviceKey:'private',jobSigningKey:'dedicated-key',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
const ticket=(scope)=>{const value=(Math.floor(Date.now()/1000)+60)+':00000000-0000-4000-8000-000000000001';return value+':'+createHmac('sha256',config.jobSigningKey).update('s2a-'+scope+':'+value).digest('hex');};
for(const scenario of ['restored','absent','expired','failure'])test(`scheduled cache recovery ${scenario} retains account and lease ownership`,async()=>{
 const credentials=await encryptCredentials({api_key:'provider-key'},config.encryptionKey);const finishes=[];let forwards=0;
 const expiry=new Date(Date.now()+(scenario==='expired'?-60000:3600000)).toISOString();
 const handler=createBackendHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_cache_jobs_claim'))return Response.json([{id:'7',lease_id:'worker-lease',upstream_name:'cachedContents/private',expire_time:expiry,account:{...credentials,id:'1',platform:'gemini',type:'apikey',credential_version:1}}]);
  if(String(url).endsWith('/s2a_personal_cache_jobs_finish')){finishes.push(JSON.parse(init.body));return Response.json(scenario!=='failure');}
  if(String(url).includes('/rpc/'))return Response.json(null);
  forwards++;assert.equal(init.method,scenario==='expired'?'DELETE':'PATCH');assert.equal(new Headers(init.headers).get('x-goog-api-key'),'provider-key');if(scenario!=='expired')assert.equal(JSON.parse(init.body).expireTime,expiry);
  return scenario==='failure'?Response.json({error:'private upstream error'},{status:503}):scenario==='absent'?new Response(null,{status:404}):scenario==='expired'?new Response(null,{status:204}):Response.json({name:'cachedContents/private',expireTime:expiry});
 });
 const response=await handler(new Request('https://gateway/internal/jobs/gemini-cache',{method:'POST',headers:{'x-s2a-gemini-cache-job-token':ticket('gemini-cache')}}));
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{claimed:1,finished:scenario==='failure'?0:1});assert.equal(forwards,1);assert.equal(finishes[0].p_id,'7');assert.equal(finishes[0].p_lease_id,'worker-lease');assert.equal(finishes[0].p_success,scenario!=='failure');assert.equal(finishes[0].p_deleted,['absent','expired'].includes(scenario));
});
test('scheduled cache recovery rejects missing credentials and cross-scope tickets before claiming jobs',async()=>{
 let calls=0;const handler=createBackendHandler(config,async()=>{calls++;return Response.json([]);});
 for(const headers of [{},{'x-s2a-gemini-cache-job-token':ticket('codex')},{authorization:'Bearer wrong'}])assert.equal((await handler(new Request('https://gateway/internal/jobs/gemini-cache',{method:'POST',headers}))).status,401);
 assert.equal(calls,0);
});
