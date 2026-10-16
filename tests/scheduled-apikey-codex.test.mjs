import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from './handler.mjs';
const config={url:'https://db.invalid',serviceKey:'service',encryptionKey:'',adminIds:[],dataModel:'native'};
const account={id:'1',platform:'openai',type:'apikey',credential_storage:'vault',credentials:{api_key:'synthetic'},credential_version:1,codex_settings:{auto_sync:'false'}};
const get=(path,tag)=>new Request('https://gateway'+path,{headers:{authorization:'Bearer sk-client',...(tag?{'if-none-match':tag}:{})}});

test('scheduled API-key discovery returns complete Codex manifests through both client routes',async()=>{
 let finishes=0;const requests=[];
 const handler=createHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',account});
  if(String(url).endsWith('/s2a_personal_finish')){finishes++;assert.equal(JSON.parse(init.body).p_status,200);return Response.json(null);}
  requests.push(new URL(url));assert.equal(new Headers(init.headers).get('authorization'),'Bearer synthetic');assert.equal(new Headers(init.headers).get('if-none-match'),null);
  return Response.json({object:'list',data:[{id:'gpt-6.1-sol',display_name:'Live name',context_window:123456},{id:'gpt-image-1'},{id:'codex-auto-review'}]});
 });
 for(const path of ['/backend-api/codex/models','/v1/models?client_version=0.150.0']){
  const first=await handler(get(path));assert.equal(first.status,200);const body=await first.json();assert.equal(body.data,undefined);assert.deepEqual(body.models.map(m=>m.slug),['gpt-6.1-sol']);assert.equal(body.models[0].display_name,'Live name');assert.equal(body.models[0].context_window,123456);assert.ok(body.models[0].model_messages.instructions_template.length>1000);
  const second=await handler(get(path,first.headers.get('etag')));assert.equal(second.status,304);assert.equal(await second.text(),'');
 }
 assert.equal(finishes,4);assert.equal(requests.length,2);assert.equal(requests[1].pathname,'/v1/models');assert.equal(requests[1].searchParams.get('client_version'),'0.150.0');
});

test('scheduled API-key manifests preserve source order and public mapping without pinned selection ordering',async()=>{
 const selected={...account,credentials:{api_key:'synthetic',model_mapping:{first:'target-a',second:'target-b'}}};
 const handler=createHandler(config,async(url)=>{
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',account:selected,model_allowlist:{enabled:true,models:['second','first']}});
  if(String(url).endsWith('/s2a_personal_finish'))return Response.json(null);
  return Response.json({models:[{slug:'target-a',context_window:123456},{slug:'target-b',context_window:654321}]});
 });
 const response=await handler(get('/backend-api/codex/models'));assert.equal(response.status,200);const models=(await response.json()).models;assert.deepEqual(models.map(m=>m.slug),['first','second']);assert.equal(models[0].context_window,123456);assert.equal(models[1].context_window,654321);
});

test('scheduled API-key model detail remains an ordinary visible catalog entry',async()=>{
 const handler=createHandler(config,async(url)=>{
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',account});
  if(String(url).endsWith('/s2a_personal_finish'))return Response.json(null);
  return Response.json({object:'list',data:[{id:'gpt-image-1',created:123,owned_by:'source'}]});
 });
 const response=await handler(get('/v1/models/gpt-image-1?client_version=0.150.0','*'));assert.equal(response.status,200);assert.equal(response.headers.get('etag'),null);assert.equal((await response.json()).created,123);
});

test('scheduled API-key Codex discovery cannot bypass provider-specific route restrictions',async()=>{
 let providerCalls=0;
 const handler=createHandler(config,async(url)=>{
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',account});
  if(String(url).endsWith('/s2a_personal_finish'))return Response.json(null);
  if(String(url).startsWith('https://api.openai.com'))providerCalls++;
  return Response.json(null);
 });
 const wrong=await handler(get('/antigravity/v1/models?client_version=0.150.0'));assert.equal(wrong.status,400);assert.equal((await wrong.json()).error.type,'provider_route_mismatch');
 assert.notEqual((await handler(get('/v1beta/models?client_version=0.150.0'))).status,200);assert.equal(providerCalls,0);
});
