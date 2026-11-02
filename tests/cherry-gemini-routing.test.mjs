import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackendHandler} from './handler.mjs';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
const config={url:'https://db.invalid',serviceKey:'service',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};

for(const prefix of ['/models','/v1/models'])for(const action of ['generateContent','streamGenerateContent','countTokens'])test(`Cherry Studio Gemini API-key request ${prefix}/gemini-3-flash:${action} reaches the native provider`,async()=>{
 const stored=await encryptCredentials({api_key:'provider-key'},config.encryptionKey);
 let acquired=0,finished=0,forwarded=0;
 const app=createBackendHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_key_policy'))return Response.json({platform:'gemini'});
  if(String(url).endsWith('/s2a_personal_acquire')){
   acquired++;const args=JSON.parse(init.body);assert.equal(args.p_model,'gemini-3-flash');
   assert.equal(args.p_billing_context.inbound_endpoint,`/v1beta/models/gemini-3-flash:${action}`);
   return Response.json({lease_id:crypto.randomUUID(),account:{...stored,id:'1',platform:'gemini',type:'apikey',credential_version:1}});
  }
  if(String(url).endsWith('/s2a_personal_finish')){finished++;return Response.json({applied:true});}
  if(String(url).includes('/rpc/'))return Response.json(null);
  forwarded++;const target=new URL(url);
  assert.equal(target.pathname,`/v1beta/models/gemini-3-flash:${action}`);
  assert.equal(new Headers(init.headers).get('x-goog-api-key'),'provider-key');
  if(action==='countTokens')return Response.json({totalTokens:3});
  const value={candidates:[{content:{role:'model',parts:[{text:'OK.'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:1}};
  return action==='streamGenerateContent'?new Response('data: '+JSON.stringify(value)+'\n\n',{headers:{'content-type':'text/event-stream'}}):Response.json(value);
 });
 const response=await app(new Request(`https://gateway/functions/v1/sub2api${prefix}/gemini-3-flash:${action}${action==='streamGenerateContent'?'?alt=sse':''}`,{method:'POST',headers:{'x-goog-api-key':'client-key','content-type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:'Reply OK.'}]}]})}));
 assert.equal(response.status,200);assert.match(await response.text(),action==='countTokens'?/totalTokens/:/OK\./);
 assert.equal(acquired,1);assert.equal(forwarded,1);assert.equal(finished,1);
});

test('Cherry native aliases still reject missing and conflicting credentials before provider dispatch',async()=>{
 const app=createBackendHandler(config,async()=>{assert.fail('Rejected credentials must not dispatch');});
 for(const [headers,status] of [[{},401],[{'x-goog-api-key':'client-key',authorization:'Bearer different-key'},400]]){
  const response=await app(new Request('https://gateway/models/gemini-3-flash:generateContent',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:'Hi'}]}]})}));
  assert.equal(response.status,status);
 }
});
