import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import NodeWebSocket,{WebSocketServer} from 'ws';
import {Database} from '../supabase/functions/sub2api/db.ts';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
import {openAIResponsesWebSocket} from '../supabase/functions/sub2api/openai_responses_ws.ts';
class Client{
 readyState=1;bufferedAmount=0;sent=[];
 send(text){this.sent.push(JSON.parse(text));this.onSent?.(JSON.parse(text));}
 close(code){this.readyState=3;this.code=code;}
}
async function setup(t){
 const server=new WebSocketServer({port:0,host:'127.0.0.1'});await once(server,'listening');t.after(async()=>{for(const socket of server.clients)socket.terminate();await new Promise(resolve=>server.close(resolve));});
 const client=new Client(),requests=[],finishes=[],stored=await encryptCredentials({api_key:'provider-private'},Buffer.alloc(32,7).toString('base64'));
 const db=new Database({url:'https://db.invalid',serviceKey:'private',encryptionKey:Buffer.alloc(32,7).toString('base64'),dataModel:'native'},async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_key_policy'))return Response.json({platform:'openai'});
  if(String(url).endsWith('/s2a_personal_acquire')){requests.push(JSON.parse(init.body));return Response.json({lease_id:'lease-'+requests.length,account:{...stored,id:'1',type:'apikey',platform:'openai',credential_version:1}});}
  if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
  throw Error('Unexpected RPC');
 });
 const request=new Request('https://gateway/v1/responses',{headers:{upgrade:'websocket'}}),abort=new AbortController();
 const dial=(url,options)=>{assert.equal(url.href,'wss://api.openai.com/v1/responses');assert.equal(options.headers.authorization,'Bearer provider-private');assert.equal(options.headers['openai-beta'],'responses_websockets=2026-02-06');return new NodeWebSocket('ws://127.0.0.1:'+server.address().port,options);};
 await openAIResponsesWebSocket(new Request(request,{signal:abort.signal}),'sk-client',db,()=>({response:new Response(null),socket:client}),dial);
 t.after(()=>abort.abort());return {server,client,requests,finishes};
}
function waitFor(client,predicate){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Event timed out')),3000);client.onSent=event=>{if(predicate(event)){clearTimeout(timer);resolve(event);}};});}
test('Responses WebSocket pins one account and records each turn before forwarding completion',async t=>{
 const f=await setup(t);let turn=0;
 f.server.on('connection',socket=>socket.on('message',text=>{
  const value=JSON.parse(text);assert.equal(value.model,'gpt-6.1-sol');assert.equal(value.type,'response.create');if(turn===1)assert.equal(value.previous_response_id,'resp_1');
  turn++;socket.send(JSON.stringify({type:'response.output_text.delta',delta:'OK'}));socket.send(JSON.stringify({type:'response.completed',response:{id:'resp_'+turn,status:'completed',usage:{input_tokens:turn,output_tokens:2}}}));
 }));
 for(let turn=1;turn<=2;turn++){
  const done=waitFor(f.client,e=>e.type==='response.completed');f.client.onmessage({data:JSON.stringify({type:'response.create',model:'gpt-6.1',input:'Hello',...(turn===2?{previous_response_id:'resp_1'}:{})})});await done;
  assert.equal(f.finishes.length,turn);assert.equal(f.finishes[turn-1].p_input_tokens,turn);assert.equal(f.finishes[turn-1].p_outcome,'completed');
 }
 assert.equal(f.requests[0].p_billing_context.websocket_account,undefined);assert.equal(f.requests[1].p_billing_context.websocket_account,'1');assert.notEqual(f.requests[0].p_request_id,f.requests[1].p_request_id);
 f.client.onclose();
});
test('Responses WebSocket rejects changing models and releases an interrupted turn',async t=>{
 const f=await setup(t);f.server.on('connection',socket=>socket.on('message',()=>socket.send(JSON.stringify({type:'response.completed',response:{usage:{input_tokens:1,output_tokens:1}}}))));
 let done=waitFor(f.client,e=>e.type==='response.completed');f.client.onmessage({data:JSON.stringify({model:'gpt-6.1',input:'Hello'})});await done;
 done=waitFor(f.client,e=>e.type==='error');f.client.onmessage({data:JSON.stringify({model:'gpt-6',input:'Hello'})});const event=await done;assert.equal(event.error.code,'model_change_requires_reconnect');assert.equal(f.requests.length,1);
});
test('Responses WebSocket cancellation records one cancelled active lease',async t=>{
 const f=await setup(t);let received;const ready=new Promise(resolve=>{received=resolve;});f.server.on('connection',socket=>socket.on('message',received));
 f.client.onmessage({data:JSON.stringify({model:'gpt-6.1',input:'Hello'})});await ready;f.client.onclose();
 for(let i=0;i<20&&!f.finishes.length;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.finishes.length,1);assert.equal(f.finishes[0].p_outcome,'cancelled');
});
