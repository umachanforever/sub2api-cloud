import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateGeminiTokens} from '../supabase/functions/sub2api/gemini_count_tokens.ts';
import {createBackendHandler} from './handler.mjs';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
const config={url:'https://database.invalid',serviceKey:'private',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
const input={contents:[{parts:[{text:'hello world!'},{text:'中文内容'},{inlineData:{mimeType:'image/png',data:'ignored'}}]}]};
test('Gemini fallback uses native ASCII/CJK text estimates and tolerates malformed optional fields',()=>{
 assert.equal(estimateGeminiTokens(input),7);assert.equal(estimateGeminiTokens({systemInstruction:{parts:[{text:'abcdef'}]},contents:input.contents}),9);assert.equal(estimateGeminiTokens({systemInstruction:{parts:{}},contents:[{parts:null}]}),0);
});
for(const scenario of ['apikey','oauth','scope','network','rate-limit','server','denied','invalid-scope-error','malformed'])test(`Gemini token counting ${scenario} releases its count-only lease without generation usage`,async()=>{
 const oauth=['oauth','scope','invalid-scope-error'].includes(scenario),credentials=await encryptCredentials(oauth?{access_token:'oauth-token',project_id:'cli-project',expires_at:Date.now()+3600000}:{api_key:'provider-key'},config.encryptionKey);const finishes=[];let acquired=0;
 const handler=createBackendHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_key_policy'))return Response.json({platform:'gemini'});
  if(String(url).endsWith('/s2a_personal_acquire')){acquired++;assert.equal(JSON.parse(init.body).p_billing_context.count_only,true);return Response.json({lease_id:'lease',account:{...credentials,id:'1',platform:'gemini',type:oauth?'oauth':'apikey',credential_version:1}});}
  if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
  if(String(url).includes('/rpc/'))return Response.json(null);
  assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-count:countTokens');assert.equal(init.method,'POST');const headers=new Headers(init.headers);assert.equal(headers.get(oauth?'authorization':'x-goog-api-key'),oauth?'Bearer oauth-token':'provider-key');if(oauth)assert.equal(headers.has('x-goog-api-key'),false);
  if(scenario==='network')throw new TypeError('network');
  if(scenario==='scope')return Response.json({error:{details:[{reason:'ACCESS_TOKEN_SCOPE_INSUFFICIENT'}]}},{status:403});
  if(scenario==='invalid-scope-error')return Response.json({error:{details:{some:true}}},{status:403});
  if(scenario==='denied')return Response.json({error:{message:'private account detail'}},{status:403});
  if(scenario==='rate-limit'||scenario==='server')return Response.json({error:'unavailable'},{status:scenario==='rate-limit'?429:503});
  return Response.json(scenario==='malformed'?{tokens:'wrong'}:{totalTokens:23,cachedContentTokenCount:8});
 });
 const response=await handler(new Request('https://gateway/v1beta/models/gemini-count:countTokens',{method:'POST',headers:{'x-goog-api-key':'sk-client','content-type':'application/json'},body:JSON.stringify(input)}));
 const failed=['denied','invalid-scope-error','malformed'].includes(scenario);assert.equal(response.status,['denied','invalid-scope-error'].includes(scenario)?403:scenario==='malformed'?502:200);assert.equal(acquired,1);assert.equal(finishes.length,1);assert.equal(finishes[0].p_outcome,failed?'failed':'completed');assert.equal(finishes[0].p_input_tokens,null);
 if(!failed)assert.equal((await response.json()).totalTokens,['scope','network','rate-limit','server'].includes(scenario)?7:23);
});
test('nested Gemini cache counts retain the owning account, private cache name and mapped model',async()=>{
 const credentials=await encryptCredentials({api_key:'provider-key'},config.encryptionKey);let forwarded=0;
 const handler=createBackendHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_cache_resolve'))return Response.json({account_id:'1',upstream_name:'cachedContents/private',upstream_model:'gemini-upstream'});
  if(String(url).endsWith('/s2a_personal_key_policy'))return Response.json({platform:'gemini'});
  if(String(url).endsWith('/s2a_personal_acquire')){assert.equal(JSON.parse(init.body).p_billing_context.cached_content,'cachedContents/public');return Response.json({lease_id:'lease',account:{...credentials,id:'1',platform:'gemini',type:'apikey',credential_version:1}});}
  if(String(url).includes('/rpc/'))return Response.json({applied:true});
  forwarded++;assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-upstream:countTokens');const body=JSON.parse(init.body);assert.equal(body.generateContentRequest.model,'models/gemini-upstream');assert.equal(body.generateContentRequest.cachedContent,'cachedContents/private');return Response.json({totalTokens:42});
 });
 const response=await handler(new Request('https://gateway/v1beta/models/gemini-alias:countTokens',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify({generateContentRequest:{model:'models/gemini-alias',cachedContent:'cachedContents/public',...input}})}));assert.equal(response.status,200);assert.equal(forwarded,1);
});

test('Gemini token counts reject other groups before reading the request or acquiring an account',async()=>{
 let reads=0,canceled=false,acquired=0;
 const handler=createBackendHandler(config,async(url)=>{if(String(url).endsWith('/s2a_personal_key_policy'))return Response.json({platform:'openai'});if(String(url).endsWith('/s2a_personal_acquire'))acquired++;return Response.json(null);});
 const body=new ReadableStream({pull(){reads++;},cancel(){canceled=true;}},{highWaterMark:0});
 const response=await handler(new Request('https://gateway/v1beta/models/gemini-count:countTokens',{method:'POST',headers:{authorization:'Bearer sk-client'},body,duplex:'half'}));assert.equal(response.status,400);assert.equal(reads,0);assert.equal(canceled,true);assert.equal(acquired,0);
});

for(const platform of ['gemini','openai'])test(`Composite Gemini token counts use resolved ${platform} account without bypassing concrete transport checks`,async()=>{
 const stored=await encryptCredentials({api_key:'provider-private'},config.encryptionKey);let dispatched=0;const finishes=[];
 const handler=createBackendHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_key_policy'))return Response.json({platform:'composite'});
  if(String(url).endsWith('/s2a_personal_acquire')){const args=JSON.parse(init.body);assert.equal(args.p_model,'public-count');assert.equal(args.p_billing_context.count_only,true);return Response.json({lease_id:'lease',upstream_model:'gemini-upstream',account:{...stored,id:'1',platform,type:'apikey',credential_version:1}});}
  if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
  if(String(url).includes('/rpc/'))return Response.json(null);
  dispatched++;assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-upstream:countTokens');return Response.json({totalTokens:17});
 });
 const response=await handler(new Request('https://gateway/v1beta/models/public-count:countTokens',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify(input)}));
 assert.equal(response.status,platform==='gemini'?200:400);assert.equal(dispatched,platform==='gemini'?1:0);assert.equal(finishes.length,1);assert.equal(finishes[0].p_outcome,platform==='gemini'?'completed':'failed');
});
