import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackendHandler} from './handler.mjs';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
const config={url:'https://database.invalid',serviceKey:'private',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
for(const status of [200,204,404,429,500])test(`Gemini cache deletion handles provider ${status} and releases its reservation`,async()=>{
 const credentials=await encryptCredentials({api_key:'provider-key'},config.encryptionKey);let deleted=0;const finishes=[];
 const handler=createBackendHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_cache_read'))return Response.json({model:'models/gemini-cache'});
  if(String(url).endsWith('/s2a_personal_cache_resolve'))return Response.json({account_id:'1',upstream_name:'cachedContents/private',upstream_model:'gemini-upstream'});
  if(String(url).endsWith('/s2a_personal_acquire')){const input=JSON.parse(init.body);assert.equal(input.p_billing_context.count_only,true);assert.equal(input.p_billing_context.cached_content,'cachedContents/public');return Response.json({lease_id:'lease',account:{...credentials,id:'1',platform:'gemini',credential_version:1}});}
  if(String(url).endsWith('/s2a_personal_cache_mutation'))return Response.json({claimed:true});
  if(String(url).endsWith('/s2a_personal_cache_deleted')){deleted++;return Response.json({deleted:true});}
  if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
  if(String(url).includes('/rpc/'))return Response.json(null);
  assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/cachedContents/private');assert.equal(init.method,'DELETE');assert.equal(new Headers(init.headers).get('x-goog-api-key'),'provider-key');assert.equal(init.redirect,'error');
  return new Response(null,{status});
 });
 const response=await handler(new Request('https://gateway/v1beta/cachedContents/public',{method:'DELETE',headers:{'x-goog-api-key':'sk-client'}}));
 const success=[200,204,404].includes(status);assert.equal(response.status,success?200:status===500?502:status);assert.equal(deleted,success?1:0);assert.equal(finishes.length,1);assert.equal(finishes[0].p_outcome,success?'completed':'failed');
});
test('cache deletion rejects foreign references before acquiring or contacting providers',async()=>{
 let acquired=0;const handler=createBackendHandler(config,async(url)=>{
  if(String(url).endsWith('/s2a_personal_cache_read'))return Response.json({error:'cached_content_not_found',status:403});
  if(String(url).endsWith('/s2a_personal_acquire'))acquired++;return Response.json(null);
 });
 const response=await handler(new Request('https://gateway/v1beta/cachedContents/foreign',{method:'DELETE',headers:{authorization:'Bearer sk-client'}}));assert.equal(response.status,403);assert.equal(acquired,0);
});
for(const scenario of ['wrong-account','provider-network','persistence-failure'])test(`cache deletion protects state on ${scenario}`,async()=>{
 const credentials=await encryptCredentials({api_key:'provider-key'},config.encryptionKey);let writes=0,forwards=0;const finishes=[];
 const handler=createBackendHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_cache_read'))return Response.json({model:'models/gemini-cache'});
  if(String(url).endsWith('/s2a_personal_cache_resolve'))return Response.json({account_id:'1',upstream_name:'cachedContents/private',upstream_model:'gemini-upstream'});
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',account:{...credentials,id:scenario==='wrong-account'?'2':'1',platform:'gemini',credential_version:1}});
  if(String(url).endsWith('/s2a_personal_cache_mutation'))return Response.json({claimed:true});
  if(String(url).endsWith('/s2a_personal_cache_deleted')){writes++;return Response.json({error:'invalid_cache_reservation',status:409});}
  if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
  if(String(url).includes('/rpc/'))return Response.json(null);
  forwards++;if(scenario==='provider-network')throw new TypeError('network unavailable');return Response.json({});
 });
 const response=await handler(new Request('https://gateway/v1beta/cachedContents/public',{method:'DELETE',headers:{authorization:'Bearer sk-client'}}));
 assert.equal(response.status,scenario==='wrong-account'?503:scenario==='provider-network'?502:409);
 assert.equal(forwards,scenario==='wrong-account'?0:1);assert.equal(writes,scenario==='persistence-failure'?1:0);assert.equal(finishes.length,1);assert.equal(finishes[0].p_outcome,'failed');
});
