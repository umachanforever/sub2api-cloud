import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackendHandler} from './handler.mjs';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
import {validateSystemOneJson,systemOneTokens} from '../supabase/functions/sub2api/typesafe.ts';
import {nativeResponse} from '../supabase/functions/sub2api/api_key_provider.ts';
const config={url:'https://database.invalid',serviceKey:'private',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
const payload={model:'jev-latest',state:{text:'example'},questions:{valid:{type:'noul',instructions:'Is this valid?'}}};
test('System One relays its native contract and records rounded usage through native admission',async()=>{
 const stored=await encryptCredentials({api_key:'upstream-private'},config.encryptionKey),finishes=[];let calls=0;
 const wire=' { "answers": {"valid":true}, "model":"jev-latest", "usage":{"input_tokens":"2.6","output_tokens":1} }\n';
 const handler=createBackendHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_key_policy'))return Response.json({platform:'typesafe'});
  if(String(url).endsWith('/s2a_personal_acquire')){assert.equal(JSON.parse(init.body).p_model,'jev-latest');return Response.json({lease_id:'lease',model_sources:{mapping:{'*':'wrong-model'}},account:{...stored,id:'1',platform:'typesafe',type:'apikey',credential_version:1}});}
  if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
  if(String(url).includes('/rpc/'))return Response.json(null);
  calls++;assert.equal(url,'https://api.typesafe.ai/v1/systemone');assert.equal(init.redirect,'error');assert.equal(new Headers(init.headers).get('authorization'),'Bearer upstream-private');assert.deepEqual(JSON.parse(init.body),payload);
  return new Response(wire,{headers:{'content-type':'application/json'}});
 });
 const response=await handler(new Request('https://gateway/v1/systemone',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify(payload)}));
 assert.equal(response.status,200);assert.equal(await response.text(),wire);assert.equal(calls,1);assert.equal(finishes.length,1);assert.equal(finishes[0].p_input_tokens,3);assert.equal(finishes[0].p_output_tokens,1);assert.equal(finishes[0].p_upstream_model,'jev-latest');assert.equal(finishes[0].p_outcome,'completed');
});
test('System One rejects invalid protocol fields, duplicates and case aliases',()=>{
 for(const change of [{model:'other'},{state:null},{stream:true},{stream:0},{questions:{}},{questions:{x:{type:'other'}}},{questions:{x:{type:'score',criteria:[]}}},{questions:{x:{type:'choice',criteria:[]}}}])assert.throws(()=>validateSystemOneJson(JSON.stringify({...payload,...change})));
 for(const source of ['{"model":"jev-latest","model":"jev-latest","state":"s","questions":{"x":{"type":"noul"}}}','{"model":"jev-latest","Model":"jev-latest","state":"s","questions":{"x":{"type":"noul"}}}',JSON.stringify(payload).replace('"type":"noul"','"type":"noul","Type":"noul"')])assert.throws(()=>validateSystemOneJson(source));
 for(const type of ['noul','choice','score'])validateSystemOneJson(JSON.stringify({...payload,stream:null,questions:{x:{type,criteria:type==='choice'?{}:type==='score'?['level']:null}}}));
 assert.equal(systemOneTokens('0x10'),null);assert.equal(systemOneTokens('1e30'),2**40);assert.equal(systemOneTokens(undefined),null);
});
test('System One rejects a different provider group before account admission',async()=>{
 let acquired=false;const handler=createBackendHandler(config,async url=>{if(String(url).endsWith('/s2a_personal_key_policy'))return Response.json({platform:'openai'});if(String(url).endsWith('/s2a_personal_acquire'))acquired=true;return Response.json(null);});
 const response=await handler(new Request('https://gateway/v1/systemone',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify(payload)}));assert.equal(response.status,400);assert.equal(acquired,false);
});
test('System One bounds buffered responses and preserves missing usage as unknown',async()=>{
 let finished=0;
 await assert.rejects(nativeResponse(new Response(' '.repeat(4*1024*1024+1)),'typesafe','systemone',false,new AbortController().signal,'test',async()=>{finished++;}),/upstream_response_too_large/);assert.equal(finished,0);
 const response=await nativeResponse(Response.json({answers:{}}),'typesafe','systemone',false,new AbortController().signal,'test',async(_status,usage)=>{assert.equal(usage.input,null);assert.equal(usage.output,null);finished++;});assert.equal(response.status,200);assert.equal(finished,1);
});
test('TypeSafe model discovery is local and other inference protocols cannot use its credentials',async()=>{
 const stored=await encryptCredentials({api_key:'upstream-private'},config.encryptionKey);let providerCalls=0;
 const handler=createBackendHandler(config,async(url)=>{
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',account:{...stored,id:'1',platform:'typesafe',type:'apikey',credential_version:1}});
  if(String(url).endsWith('/s2a_personal_finish'))return Response.json({applied:true});
  if(String(url).includes('/rpc/'))return Response.json(null);
  providerCalls++;throw Error('must not call provider');
 });
 const catalog=await handler(new Request('https://gateway/v1/models',{headers:{authorization:'Bearer sk-client'}}));assert.equal(catalog.status,200);assert.equal((await catalog.json()).data[0].id,'jev-latest');
 const rejected=await handler(new Request('https://gateway/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify({model:'jev-latest',messages:[{role:'user',content:'hello'}]})}));assert.equal(rejected.status,400);assert.equal(providerCalls,0);
});
