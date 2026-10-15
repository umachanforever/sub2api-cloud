import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {verifyWebSocket} from '../scripts/verify-websocket.mjs';
async function server(t, callback){
 const wss=new WebSocketServer({port:0,host:'127.0.0.1'});await once(wss,'listening');
 t.after(()=>{for(const client of wss.clients)client.terminate();wss.close();});
 wss.on('connection',callback);
 return {base_url:`http://127.0.0.1:${wss.address().port}/v1`,api_key:'sk-fixture',model:'vision-model'};
}
test('WebSocket acceptance requires two turns with previous_response_id and actual context',async t=>{
 let turns=0,code;
 const config=await server(t,(socket,request)=>{
  assert.equal(request.headers.authorization,'Bearer sk-fixture');
  socket.on('message',raw=>{
   const body=JSON.parse(raw);turns++;
   if(turns===1)code=body.input.match(/WS-[A-F0-9]{16}/)[0];
   else{assert.equal(body.previous_response_id,'response-1');assert.equal(body.input.includes(code),false);}
   socket.send(JSON.stringify({type:'response.output_text.delta',delta:code}));
   socket.send(JSON.stringify({type:'response.completed',response:{id:'response-'+turns,usage:{input_tokens:10,output_tokens:5}}}));
  });
 });
 assert.deepEqual(await verifyWebSocket(config),['websocket','websocket-context','websocket-usage']);assert.equal(turns,2);
});
test('WebSocket acceptance rejects errors without exposing upstream details',async t=>{
 const config=await server(t,socket=>socket.on('message',()=>socket.send(JSON.stringify({type:'response.failed',response:{error:{message:'private credential'}}}))));
 await assert.rejects(verifyWebSocket(config),/^Error: WebSocket verification failed: upstream did not complete the turn$/);
});
test('WebSocket acceptance validates its destination before opening a socket',async()=>{
 await assert.rejects(verifyWebSocket({base_url:'https://user:password@provider.invalid/v1',api_key:'sk',model:'m'}),/Configure an HTTP base_url/);
});

test('WebSocket acceptance handles interruption before connection without an unhandled socket error',async t=>{
 const config=await server(t,()=>{}),controller=new AbortController();controller.abort();
 await assert.rejects(verifyWebSocket(config,controller.signal),/WebSocket verification failed: interrupted/);
 await new Promise(resolve=>setImmediate(resolve));
});
test('WebSocket acceptance rejects an early clean close with its completed turn count',async t=>{
 const config=await server(t,socket=>socket.on('message',()=>socket.close(1000)));
 await assert.rejects(verifyWebSocket(config),/closed after 0 completed turns \(code 1000\)/);
});
