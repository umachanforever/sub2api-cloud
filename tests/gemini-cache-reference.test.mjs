import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackendHandler} from './handler.mjs';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
import {validateGeminiCacheJson,geminiCacheName,rewriteGeminiCache} from '../supabase/functions/sub2api/gemini_cache_reference.ts';
const config={url:'https://database.invalid',serviceKey:'private',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
const binding={account_id:'1',upstream_name:'cachedContents/provider-private',upstream_model:'gemini-upstream'};
const input={cachedContent:'cachedContents/public-cache',contents:[{role:'user',parts:[{text:'hello'}]}]};
test('Gemini cache references use the bound account, immutable upstream model and private provider name',async()=>{
 const credentials=await encryptCredentials({api_key:'provider-key'},config.encryptionKey);const finishes=[];let acquired=0,forwarded=0;
 const handler=createBackendHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_cache_resolve')){const body=JSON.parse(init.body);assert.equal(body.p_name,'cachedContents/public-cache');assert.equal(body.p_model,'gemini-cache');return Response.json(binding);}
  if(String(url).endsWith('/s2a_personal_acquire')){acquired++;assert.equal(JSON.parse(init.body).p_billing_context.cached_content,'cachedContents/public-cache');return Response.json({lease_id:'lease',upstream_model:'changed-mapping',account:{...credentials,id:'1',platform:'gemini',type:'apikey',credential_version:1}});}
  if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
  if(String(url).includes('/rpc/'))return Response.json(null);
  forwarded++;assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-upstream:generateContent');assert.equal(JSON.parse(init.body).cachedContent,binding.upstream_name);
  return Response.json({candidates:[{content:{parts:[{text:'answer'}]}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:2,cachedContentTokenCount:8}});
 });
 const response=await handler(new Request('https://gateway/v1beta/models/gemini-cache:generateContent',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify(input)}));
 assert.equal(response.status,200);await response.json();assert.equal(acquired,1);assert.equal(forwarded,1);assert.equal(finishes[0].p_upstream_model,'gemini-upstream');assert.equal(finishes[0].p_cache_read_tokens,8);
});
test('foreign, expired and model-mismatched caches are rejected before account acquisition',async()=>{
 for(const [error,status] of [['cached_content_not_found',404],['cached_content_model_mismatch',400],['ip_forbidden',403]]){
  let acquired=0;const handler=createBackendHandler(config,async(url)=>{if(String(url).endsWith('/s2a_personal_cache_resolve'))return Response.json({error,status});if(String(url).endsWith('/s2a_personal_acquire'))acquired++;return Response.json(null);});
  const response=await handler(new Request('https://gateway/v1beta/models/gemini-cache:generateContent',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify(input)}));assert.equal(response.status,status);assert.equal(acquired,0);
 }
});
test('Gemini cache references reject alternate spellings and conflicting nested references',()=>{
 for(const value of [{cached_content:'cachedContents/a'},{cachedContent:1},{cachedContent:'https://provider.invalid/cache'},{cachedContent:'cachedContents/a',generateContentRequest:{cachedContent:'cachedContents/b'}},{generateContentRequest:{cached_content:'cachedContents/a'}}])assert.throws(()=>geminiCacheName(value));
 const body={cachedContent:' cachedContents/a ',generateContentRequest:{cachedContent:'cachedContents/a'}};assert.equal(geminiCacheName(body),'cachedContents/a');assert.equal(rewriteGeminiCache(body,binding).generateContentRequest.cachedContent,binding.upstream_name);assert.equal(body.cachedContent,' cachedContents/a ');
});
test('Gemini cache requests never dispatch to a different reserved account',async()=>{
 const credentials=await encryptCredentials({api_key:'must-not-dispatch'},config.encryptionKey);let forwards=0;const finishes=[];
 const handler=createBackendHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_cache_resolve'))return Response.json(binding);
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',account:{...credentials,id:'2',platform:'gemini',type:'apikey',credential_version:1}});
  if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
  if(String(url).includes('/rpc/'))return Response.json(null);forwards++;return Response.json({});
 });
 const response=await handler(new Request('https://gateway/v1beta/models/gemini-cache:generateContent',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify(input)}));assert.equal(response.status,503);assert.equal(forwards,0);assert.equal(finishes[0].p_outcome,'failed');
});

test('raw Gemini cache references reject duplicate escaped and nested member names',()=>{
 for(const source of [
  '{"cachedContent":"cachedContents/a","cachedContent":"cachedContents/b"}',
  '{"cachedContent":"cachedContents/a","cached\\u0043ontent":"cachedContents/b"}',
  '{"generateContentRequest":{"cachedContent":"cachedContents/a","cachedContent":"cachedContents/b"}}',
  '{"generateContentRequest":{},"generateContentRequest":{"cachedContent":"cachedContents/a"}}',
 ])assert.throws(()=>validateGeminiCacheJson(source),/duplicate_cached_content_field/);
 for(const source of ['{"contents":[{"parts":[{"text":"cachedContent"}]}]}','{"other":{"cachedContent":"a","cachedContent":"b"}}','{"generateContentRequest":{"cachedContent":"cachedContents/a"}}'])validateGeminiCacheJson(source);
 assert.throws(()=>geminiCacheName({generate_content_request:{cachedContent:'cachedContents/a'}}));
});
test('duplicate cache references fail before cache lookup and account admission',async()=>{
 let admissions=0;
 const handler=createBackendHandler(config,async(url)=>{if(String(url).endsWith('/s2a_personal_acquire')||String(url).endsWith('/s2a_personal_cache_resolve'))admissions++;return Response.json(null);});
 const response=await handler(new Request('https://gateway/v1beta/models/gemini-cache:generateContent',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:'{"cachedContent":"cachedContents/a","cachedContent":"cachedContents/b","contents":[]}'}));
 assert.equal(response.status,400);assert.equal(admissions,0);
});
