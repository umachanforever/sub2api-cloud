import test from 'node:test';
import assert from 'node:assert/strict';
import {cachePatch} from '../supabase/functions/sub2api/gemini_cache_expiry.ts';
import {createBackendHandler} from './handler.mjs';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
const config={url:'https://database.invalid',serviceKey:'private',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
test('cache patches match expiry aliases, duration rounding and immutable field rules',()=>{
 const now=Date.parse('2026-10-15T00:00:00Z');
 assert.deepEqual(cachePatch({ttl:'1.1s'},'ttl',now),{expireTime:'2026-10-15T00:00:02.000Z'});
 assert.deepEqual(cachePatch({expire_time:'2026-10-15T00:01:00Z'},'expire_time',now),{expireTime:'2026-10-15T00:01:00.000Z'});
 for(const [body,mask] of [[{},''],[{ttl:'0s'},''],[{ttl:'86401s'},''],[{ttl:'NaNs'},''],[{ttl:1},''],[{ttl:'1s',expireTime:'2026-10-15T00:01:00Z'},''],[{ttl:'1s',model:'gemini'},''],[{ttl:'1s'},'model'],[{expireTime:'2026-02-30T00:00:00Z'},''],[{expireTime:'2026-10-15T24:00:00Z'},'']])assert.throws(()=>cachePatch(body,mask,now));
});
for(const scenario of ['success','busy','recovery','malformed','persistence','network'])test(`cache patch ${scenario} preserves the bound account and mutation ownership`,async()=>{
 const credentials=await encryptCredentials({api_key:'provider-key'},config.encryptionKey);const actions=[];let gets=0,patches=0,reads=0;const finishes=[];
 const expiry=new Date(Date.now()+60000).toISOString();
 const handler=createBackendHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_cache_read')){reads++;return Response.json({name:'cachedContents/public',model:'models/gemini-cache',expireTime:expiry});}
  if(String(url).endsWith('/s2a_personal_cache_resolve'))return Response.json({account_id:'1',upstream_name:'cachedContents/private',upstream_model:'gemini-upstream'});
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',account:{...credentials,id:'1',platform:'gemini',credential_version:1}});
  if(String(url).endsWith('/s2a_personal_cache_mutation')){
   const body=JSON.parse(init.body);actions.push(body.p_action);
   if(body.p_action==='claim')return Response.json(scenario==='busy'?{error:'cache_mutation_in_progress',status:409}:{claimed:true,recover:scenario==='recovery'});
   if(body.p_action==='apply'){assert.equal(body.p_expire_time,expiry);return Response.json(scenario==='persistence'?{error:'cache_mutation_conflict',status:409}:{updated:true});}
   return Response.json({released:true});
  }
  if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
  if(String(url).includes('/rpc/'))return Response.json(null);
  if(init.method==='GET'){gets++;assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/cachedContents/private');return Response.json({});}
  patches++;assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/cachedContents/private?updateMask=expireTime');assert.equal(init.method,'PATCH');assert.ok(JSON.parse(init.body).expireTime);
  if(scenario==='network')throw new TypeError('network');
  return Response.json(scenario==='malformed'?{name:'cachedContents/wrong',expireTime:expiry}:{name:'cachedContents/private',expireTime:expiry});
 });
 const response=await handler(new Request('https://gateway/v1beta/cachedContents/public?updateMask=ttl',{method:'PATCH',headers:{'x-goog-api-key':'sk-client','content-type':'application/json'},body:JSON.stringify({ttl:'60s'})}));
 const success=['success','recovery'].includes(scenario);assert.equal(response.status,success?200:['busy','persistence'].includes(scenario)?409:502);assert.equal(patches,scenario==='busy'?0:1);assert.equal(gets,scenario==='recovery'?1:0);
 assert.equal(actions.includes('release'),success);assert.equal(finishes.length,1);assert.equal(finishes[0].p_outcome,success?'completed':'failed');if(success)assert.equal((await response.json()).name,'cachedContents/public');
});
