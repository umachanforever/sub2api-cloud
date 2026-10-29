import assert from 'node:assert/strict';
import test from 'node:test';
import {Database} from '../supabase/functions/sub2api/db.ts';
import {createHandler} from '../supabase/functions/sub2api/app.ts';
import {errorClassification} from '../supabase/functions/sub2api/ops_errors.ts';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
const user='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',account='33333333-3333-4333-8333-333333333333';
const config={url:'https://db',serviceKey:'private-service-key',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[user]};
const encrypted=await encryptCredentials({api_key:'private-provider-key'},config.encryptionKey);
const root='/api/v1/admin/ops';
const request=(suffix='',method='GET',body)=>new Request('https://gateway'+root+suffix,{method,headers:{authorization:'Bearer private-user-jwt','x-s2a-frontend':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})});
test('error classification separates business limits, provider faults and invalid requests without raw error text',()=>{
 assert.equal(errorClassification('insufficient_balance',402).limited,true);
 assert.equal(errorClassification('invalid_request',400).limited,false);
 assert.equal(errorClassification('invalid_api_key',401).owner,'client');
 assert.equal(errorClassification('upstream_http',401,true).phase,'account_auth');
 assert.equal(errorClassification('upstream_http',429,true).limited,false);
 assert.equal(errorClassification('upstream_timeout',504).source,'gateway');
 assert.equal(errorClassification('private-password',500).code,'gateway_error');
});
async function gatewayFixture(provider) {
 const events=[],leases=[];let attempts=0;
 const handler=createHandler(config,async(url,init)=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/s2a_log_write'))return Response.json(true);
  if(path.endsWith('/s2a_ops_error_record')){events.push(JSON.parse(init.body).p_event);return Response.json(events.length);}
  if(path.endsWith('/s2a_acquire')){const args=JSON.parse(init.body);leases.push(args.p_request_id);if(++attempts>2)return Response.json({error:'no_available_account',status:503});return Response.json({lease_id:crypto.randomUUID(),account:{id:account,...encrypted,platform:'openai',type:'apikey',credential_version:1}});}
  if(path.endsWith('/s2a_finish'))return Response.json(null);
  assert.equal(new URL(url).hostname,'api.openai.com');return provider(attempts);
 });
 return {events,leases,handler,request:body=>handler(new Request('https://gateway/v1/chat/completions?secret=private-query',{method:'POST',headers:{authorization:'Bearer private-gateway-key','content-type':'application/json'},body:JSON.stringify(body)}))};
}
test('a recovered provider failure remains an upstream event without inventing a failed client request',async()=>{
 const value=await gatewayFixture(attempt=>attempt===1?new Response('private-provider-error',{status:429}):Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:'ok'}}],usage:{prompt_tokens:1,completion_tokens:1}}));
 const response=await value.request({model:'gpt-4.1',messages:[{role:'user',content:'private-user-prompt'}],stream:false});
 assert.equal(response.status,200);assert.equal(value.events.length,1);assert.equal(value.events[0].kind,'upstream');assert.equal(value.events[0].status_code,429);
 assert.equal(value.events[0].request_id,value.leases[0]);assert.equal(value.leases[0],value.leases[1]);
 assert.equal(JSON.stringify(value.events).includes('private-'),false);assert.equal(value.events[0].key_hash.length,64);
});
test('exhausted account attempts produce one final request error linked to every provider failure',async()=>{
 const value=await gatewayFixture(()=>new Response('private-error',{status:500}));
 assert.equal((await value.request({model:'gpt-4.1',messages:[{role:'user',content:'private'}],stream:false})).status,502);
 assert.equal(value.events.filter(event=>event.kind==='upstream').length,2);
 const final=value.events.filter(event=>event.kind==='request');assert.equal(final.length,1);assert.equal(final[0].phase,'upstream');assert.ok(value.events.every(event=>event.request_id===final[0].request_id));
});
test('malformed requests retain a hashed key attribution without reading or storing their body',async()=>{
 const value=await gatewayFixture(()=>{throw Error('never');});
 const response=await value.handler(new Request('https://gateway/responses',{method:'POST',headers:{authorization:'Bearer private-gateway-key','content-type':'application/json'},body:'private-malformed-prompt'}));
 assert.equal(response.status,400);assert.equal(value.events[0].kind,'request');assert.equal(value.events[0].endpoint,'/responses');assert.equal(value.events[0].stream,null);assert.equal(value.events[0].key_hash.length,64);assert.equal(JSON.stringify(value.events).includes('private'),false);
});
test('incomplete streams preserve the observed HTTP status and log one client error plus one provider event',async()=>{
 const value=await gatewayFixture(()=>new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',{headers:{'content-type':'text/event-stream'}}));
 const response=await value.request({model:'gpt-4.1',messages:[{role:'user',content:'hi'}],stream:true});assert.equal(response.status,200);await response.text();
 assert.equal(value.events.filter(event=>event.kind==='request').length,1);assert.equal(value.events.filter(event=>event.kind==='upstream').length,1);
 assert.ok(value.events.every(event=>event.status_code===200));
});

test('cancelling a stream is a client event and never a provider fault',async()=>{
 const value=await gatewayFixture(()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));}}),{headers:{'content-type':'text/event-stream'}}));
 const response=await value.request({model:'gpt-4.1',messages:[{role:'user',content:'hi'}],stream:true});
 const reader=response.body.getReader();await reader.read();await reader.cancel();
 assert.equal(value.events.length,1);assert.equal(value.events[0].kind,'request');assert.equal(value.events[0].owner,'client');assert.equal(value.events[0].limited,true);
});
test('OAuth recovery and a subsequent provider failure retain two separate upstream events',async()=>{
 const old=await encryptCredentials({access_token:'private-old',refresh_token:'private-refresh',chatgpt_account_id:'private-account',expires_at:2100000000},config.encryptionKey);
 const fresh=await encryptCredentials({access_token:'private-new',refresh_token:'private-refresh',chatgpt_account_id:'private-account',expires_at:2100000000},config.encryptionKey);
 const events=[];let providers=0,reservations=0;
 const handler=createHandler(config,async(url,init)=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/s2a_log_write'))return Response.json(true);
  if(path.endsWith('/s2a_ops_error_record')){events.push(JSON.parse(init.body).p_event);return Response.json(events.length);}
  if(path.endsWith('/s2a_acquire'))return Response.json(++reservations===1?{lease_id:crypto.randomUUID(),account:{id:account,...old,platform:'openai',type:'oauth',credential_version:1}}:{error:'no_available_account',status:503});
  if(path.endsWith('/s2a_accounts'))return Response.json([{id:account,...fresh,credential_version:2}]);
  if(path.endsWith('/s2a_finish'))return Response.json(null);
  assert.equal(new URL(url).hostname,'chatgpt.com');return new Response('private-body',{status:++providers===1?401:502});
 });
 const response=await handler(new Request('https://gateway/v1/responses',{method:'POST',headers:{authorization:'Bearer key','content-type':'application/json'},body:JSON.stringify({model:'gpt-4.1',input:'hello',stream:false})}));
 assert.equal(response.status,502);assert.deepEqual(events.filter(event=>event.kind==='upstream').map(event=>event.status_code),[401,502]);assert.equal(events.filter(event=>event.kind==='request').length,1);
 assert.equal(JSON.stringify(events).includes('private'),false);
});

test('invalid provider JSON is a protocol fault rather than a network error',async()=>{
 const value=await gatewayFixture(()=>new Response('private-invalid-json',{headers:{'content-type':'application/json'}}));
 assert.equal((await value.request({model:'gpt-4.1',messages:[{role:'user',content:'hi'}],stream:false})).status,502);
 const upstream=value.events.find(event=>event.kind==='upstream');assert.equal(upstream.phase,'upstream');assert.equal(upstream.code,'upstream_response_failed');assert.equal(upstream.source,'gateway');
});

test('client abort before provider headers is excluded without blaming the provider',async()=>{
 const controller=new AbortController();
 const value=await gatewayFixture(()=>{controller.abort();throw new DOMException('private-abort','AbortError');});
 const response=await value.handler(new Request('https://gateway/v1/chat/completions',{method:'POST',signal:controller.signal,headers:{authorization:'Bearer key','content-type':'application/json'},body:JSON.stringify({model:'gpt-4.1',messages:[{role:'user',content:'hi'}]})}));
 assert.equal(response.status,504);assert.equal(value.events.length,1);assert.equal(value.events[0].kind,'request');assert.equal(value.events[0].code,'context_canceled');assert.equal(value.events[0].limited,true);
});
