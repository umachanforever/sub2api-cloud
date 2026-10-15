import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import NodeWebSocket,{WebSocketServer} from 'ws';
import {relayGrokRealtime} from '../supabase/functions/sub2api/grok_realtime.ts';
import {createBackendHandler} from './handler.mjs';
class Client {
 readyState=0;bufferedAmount=0;sent=[];
 send(value){this.sent.push(value);this.onSent?.(value);}
 close(code){this.readyState=3;this.code=code;}
 open(){this.readyState=1;this.onopen();}
}
async function fixture(t){const server=new WebSocketServer({port:0,host:'127.0.0.1'});await once(server,'listening');t.after(async()=>{for(const socket of server.clients)socket.terminate();await new Promise(resolve=>server.close(resolve));});return server;}
test('realtime relays exact text and binary frames with private handshake headers',async t=>{
 const server=await fixture(t),client=new Client(),abort=new AbortController(),finishes=[];
 server.on('connection',(socket,request)=>{assert.equal(request.headers.authorization,'Bearer upstream-private');socket.on('message',(data,binary)=>socket.send(data,{binary}));});
 const response=await relayGrokRealtime(new Request('https://gateway/v1/realtime'),'https://api.x.ai/v1/realtime?model=grok-voice-latest',new Headers({authorization:'Bearer upstream-private'}),null,abort.signal,async(status,usage)=>finishes.push({status,usage}),()=>({response:new Response(null),socket:client}),(url,options)=>{assert.equal(url.protocol,'wss:');assert.equal(url.searchParams.get('model'),'grok-voice-latest');return new NodeWebSocket('ws://127.0.0.1:'+server.address().port,options);});
 assert.equal(response.status,200);client.open();
 for(const value of ['{"type":"session.update"}',new Uint8Array([0,255,1]).buffer]){
  const received=new Promise(resolve=>{client.onSent=resolve;});client.onmessage({data:value});const result=await received;
  if(typeof value==='string')assert.equal(result,value);else assert.deepEqual(new Uint8Array(result),new Uint8Array(value));
 }
 client.onclose({code:1000});await new Promise(resolve=>setImmediate(resolve));assert.equal(finishes.length,1);assert.equal(finishes[0].usage.outcome,'completed');assert.equal(finishes[0].usage.input,null);abort.abort();assert.equal(finishes.length,1);
});
test('realtime abort and client backpressure close both sides and finish once',async t=>{
 for(const mode of ['abort','pressure']){const server=await fixture(t),client=new Client(),abort=new AbortController(),finishes=[];
  server.on('connection',socket=>{if(mode==='pressure')socket.on('message',()=>socket.send('reply'));});
  await relayGrokRealtime(new Request('https://gateway/v1/realtime'),'https://api.x.ai/v1/realtime',new Headers(),null,abort.signal,async(status,usage)=>finishes.push({status,usage}),()=>({response:new Response(null),socket:client}),(_url,options)=>new NodeWebSocket('ws://127.0.0.1:'+server.address().port,options));client.open();
  if(mode==='abort')abort.abort();else{client.bufferedAmount=16*1024*1024;client.onmessage({data:'hello'});}
  for(let i=0;i<20&&!finishes.length;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(finishes.length,1);assert.equal(client.code,mode==='abort'?1001:1009);
 }
});
test('realtime requires an upgrade and validates key platform before upstream connection',async()=>{
 const config={url:'https://database.invalid',serviceKey:'private',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
 let acquired=0;const handler=createBackendHandler(config,async url=>{if(String(url).endsWith('/s2a_personal_key_policy'))return Response.json({platform:'openai'});if(String(url).endsWith('/s2a_personal_acquire'))acquired++;return Response.json(null);});
 const plain=await handler(new Request('https://gateway/v1/realtime',{headers:{authorization:'Bearer sk-client'}}));assert.equal(plain.status,426);
 const wrong=await handler(new Request('https://gateway/v1/realtime',{headers:{authorization:'Bearer sk-client',upgrade:'websocket'}}));assert.equal(wrong.status,400);assert.equal(acquired,0);
});
test('realtime client upgrade failure releases the reservation and closes the upstream',async t=>{
 const server=await fixture(t),finishes=[];let upgraded=false;
 await assert.rejects(relayGrokRealtime(new Request('https://gateway/v1/realtime'),'https://api.x.ai/v1/realtime',new Headers(),null,new AbortController().signal,async(status,usage)=>finishes.push({status,usage}),()=>{upgraded=true;throw new Error('client upgrade failed');},(_url,options)=>new NodeWebSocket('ws://127.0.0.1:'+server.address().port,options)),/realtime_upstream_unavailable/);
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(upgraded,true);assert.equal(finishes.length,1);assert.equal(finishes[0].usage.outcome,'failed');
});
test('realtime abort during handshake releases the reservation and removes abort listeners',async t=>{
 const server=await fixture(t),abort=new AbortController(),finishes=[];let upstream;
 const original=abort.signal.addEventListener.bind(abort.signal),remove=abort.signal.removeEventListener.bind(abort.signal),listeners=new Set();
 abort.signal.addEventListener=(type,listener,options)=>{if(type==='abort')listeners.add(listener);return original(type,listener,options);};
 abort.signal.removeEventListener=(type,listener,options)=>{if(type==='abort')listeners.delete(listener);return remove(type,listener,options);};
 const result=relayGrokRealtime(new Request('https://gateway/v1/realtime'),'https://api.x.ai/v1/realtime',new Headers(),null,abort.signal,async(status,usage)=>finishes.push({status,usage}),()=>{throw new Error('must not upgrade');},(_url,options)=>{upstream=new NodeWebSocket('ws://127.0.0.1:'+server.address().port,options);queueMicrotask(()=>abort.abort());return upstream;});
 await assert.rejects(result,/realtime_connect_cancelled/);await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(finishes.length,1);assert.equal(finishes[0].usage.outcome,'cancelled');assert.equal(listeners.size,0);assert.equal(upstream.readyState,NodeWebSocket.CLOSED);
});
