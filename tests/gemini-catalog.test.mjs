import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeGeminiCatalog,geminiCatalogScopeFallback} from '../supabase/functions/sub2api/gemini_catalog.ts';
import {fallbackGeminiCatalog,GEMINI_FALLBACK_IDS} from '../supabase/functions/sub2api/gemini_catalog.ts';
import {readFileSync} from 'node:fs';

test('Gemini fallback IDs stay aligned with the original Go catalog',()=>{
 const source=readFileSync(new URL('../backend/internal/pkg/gemini/models.go',import.meta.url),'utf8');
 assert.deepEqual(GEMINI_FALLBACK_IDS,[...source.split('func HasFallbackModel')[0].matchAll(/Name: "models\/([^"]+)"/g)].map(match=>match[1]));
});
test('Gemini fallback handles scope failures and only known model 404s',async()=>{
 const listed=await fallbackGeminiCatalog(new Response('access_token_scope_insufficient',{status:403}),'/v1beta/models');
 assert.equal(listed.status,200);assert.equal((await listed.json()).models.length,GEMINI_FALLBACK_IDS.length);
 const detail=await fallbackGeminiCatalog(new Response('{}',{status:404}),'/v1beta/models/gemini-3.1-pro-preview-customtools');
 assert.equal(detail.status,200);assert.equal((await detail.json()).name,'models/gemini-3.1-pro-preview-customtools');
 for(const [status,body,path] of [[404,'{}','/v1beta/models/unknown'],[401,'bad key','/v1beta/models'],[503,'access_token_scope_insufficient','/v1beta/models']]){
  const original=new Response(body,{status});assert.equal(await fallbackGeminiCatalog(original,path),original);assert.equal(await original.text(),body);
 }
});

test('Gemini aggregation preserves native metadata, envelope extensions and pagination',()=>{
 const native={models:[{name:'models/native',unknown:{tools:true}}],nextPageToken:'opaque',extension:42};
 const result=JSON.parse(mergeGeminiCatalog(JSON.stringify(native),[
  {name:'models/native',unknown:false},{name:'models/extra',displayName:'Extra'},{name:'models/extra'},
 ]));
 assert.deepEqual(result,{...native,models:[native.models[0],{name:'models/extra',displayName:'Extra'}]});
});
test('Gemini aggregation leaves unchanged and malformed upstream bodies byte-for-byte intact',()=>{
 for(const body of ['bad','null','[]','{"models":false}','{"models":[null]}','{ "models": [{"name":"models/native"}] }'])
  assert.equal(mergeGeminiCatalog(body,[{name:'models/native'}]),body);
});
test('Gemini catalog fallback cannot hide ordinary authentication errors or upstream outages',()=>{
 for(const status of [401,403]){
  assert.equal(geminiCatalogScopeFallback(status,new Headers(),'Invalid API key'),false);
  assert.equal(geminiCatalogScopeFallback(status,new Headers(),'ACCESS_TOKEN_SCOPE_INSUFFICIENT'),true);
  assert.equal(geminiCatalogScopeFallback(status,new Headers({'www-authenticate':'Bearer error="insufficient_scope"'}),''),true);
 }
 for(const status of [200,404,429,500,503]) assert.equal(geminiCatalogScopeFallback(status,new Headers(),'insufficient authentication scopes'),false);
});

import {createBackendHandler} from './handler.mjs';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
test('native Gemini scope fallback passes through gateway catalog filtering and releases the lease',async()=>{
 const config={url:'https://database.invalid',serviceKey:'private',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
 const stored=await encryptCredentials({api_key:'provider-key'},config.encryptionKey);const finishes=[];
 const app=createBackendHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_key_policy'))return Response.json({platform:'gemini'});
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',model_allowlist:{enabled:true,models:['gemini-3.1-pro-preview-customtools']},account:{...stored,id:'1',platform:'gemini',type:'apikey',credential_version:1}});
  if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
  if(String(url).includes('/rpc/'))return Response.json(null);
  assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/models');
  return Response.json({error:{message:'insufficient authentication scopes'}},{status:403});
 });
 const response=await app(new Request('https://gateway/v1beta/models',{headers:{authorization:'Bearer sk-client'}}));
 assert.equal(response.status,200);const result=await response.json();
 assert.deepEqual(result.models.map(model=>model.name),['models/gemini-3.1-pro-preview-customtools']);
 assert.equal(finishes.length,1);assert.equal(finishes[0].p_outcome,'completed');assert.equal(finishes[0].p_input_tokens,null);
});

test('native Gemini catalog preserves upstream metadata and opaque pagination through the gateway',async()=>{
 const config={url:'https://database.invalid',serviceKey:'private',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
 const stored=await encryptCredentials({api_key:'provider-key'},config.encryptionKey);
 const value={models:[{name:'models/gemini-future',extension:{newCapability:true}}],nextPageToken:'opaque-next',extension:'native'};
 const app=createBackendHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_acquire')){
   assert.equal(JSON.parse(init.body).p_billing_context.inbound_endpoint,'/v1beta/models');
   return Response.json({lease_id:'lease',model_sources:{mapping:{},include_upstream:true},account:{...stored,id:'1',platform:'gemini',type:'apikey',credential_version:1}});
  }
  if(String(url).includes('/rpc/'))return Response.json({applied:true});
  const target=new URL(url);assert.equal(target.searchParams.get('pageToken'),'opaque-first');assert.equal(target.searchParams.get('pageSize'),'2');
  return Response.json(value);
 });
 const response=await app(new Request('https://gateway/v1beta/models?pageToken=opaque-first&pageSize=2',{headers:{authorization:'Bearer sk-client'}}));
 assert.equal(response.status,200);assert.deepEqual(await response.json(),value);
});
