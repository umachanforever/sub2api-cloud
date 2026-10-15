import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer,request} from 'node:http';
import {createHash} from 'node:crypto';
import {createConsoleServer} from '../scripts/console.mjs';
const key='sb_publishable_'+ 'x'.repeat(24);
async function listen(server,t){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const sockets=new Set();server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});return server.address().port;}
test('console WebSocket tunnel preserves frames and negotiates only the public protocol',async t=>{
 const upstream=createServer();const payload=JSON.stringify({type:'qps_update',data:{qps:1}});
 upstream.on('upgrade',(req,socket)=>{
  assert.equal(req.url,'/api/v1/admin/ops/ws/qps');assert.equal(req.headers.apikey,undefined);assert.deepEqual(req.headers['sec-websocket-protocol'].split(',').map(value=>value.trim()),['sub2api-admin','jwt.fixture']);
  const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: sub2api-admin\r\n\r\n`);
  socket.write(Buffer.concat([Buffer.from([0x81,Buffer.byteLength(payload)]),Buffer.from(payload)]));
 });
 const upstreamPort=await listen(upstream,t),proxy=createConsoleServer({config:{mode:'local',supabase_url:`http://127.0.0.1:${upstreamPort}`,publishable_key:key,management_url:`http://127.0.0.1:${upstreamPort}`}}),port=await listen(proxy,t);
 const ws=new WebSocket(`ws://127.0.0.1:${port}/api/v1/admin/ops/ws/qps`,['sub2api-admin','jwt.fixture']);
 const data=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('timeout')),2000);ws.addEventListener('message',event=>{clearTimeout(timer);resolve(JSON.parse(event.data));},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('failed'));},{once:true});});
 assert.equal(ws.protocol,'sub2api-admin');assert.equal(data.data.qps,1);ws.close();
});
test('console WebSocket rejects hostile origins, other routes and query credentials before upstream',async t=>{
 const server=createConsoleServer({config:{mode:'local',supabase_url:'http://127.0.0.1:1',publishable_key:key,management_url:'http://127.0.0.1:1'}}),port=await listen(server,t);
 async function rejected(path,headers={}){return await new Promise((resolve,reject)=>{const req=request(`http://127.0.0.1:${port}${path}`,{headers:{connection:'Upgrade',upgrade:'websocket','sec-websocket-version':'13','sec-websocket-key':'dGhlIHNhbXBsZSBub25jZQ==',...headers}},response=>{response.resume();resolve(response.statusCode);});req.on('error',reject);req.end();});}
 assert.equal(await rejected('/api/v1/admin/ops/ws/qps',{origin:'https://evil.example'}),403);
 assert.equal(await rejected('/api/v1/admin/ops/ws/qps?token=secret'),404);
 assert.equal(await rejected('/api/v1/admin/settings'),404);
 assert.equal(await rejected('/api/v1/admin/ops/ws/qps',{host:'evil.example'}),403);
});

test('console realtime tunnel uses the cloud function and preserves bearer headers and model',async t=>{
 const upstream=createServer();upstream.on('upgrade',(req,socket)=>{
  assert.equal(req.url,'/functions/v1/sub2api/v1/realtime?model=grok-voice-latest');assert.equal(req.headers.authorization,'Bearer client-key');
  const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);socket.write(Buffer.from([0x81,2,111,107]));
 });
 const upstreamPort=await listen(upstream,t),proxy=createConsoleServer({config:{mode:'local',supabase_url:`http://127.0.0.1:${upstreamPort}`,publishable_key:key,management_url:'http://127.0.0.1:1'}}),port=await listen(proxy,t);
 const {default:Socket}=await import('ws');const socket=new Socket(`ws://127.0.0.1:${port}/v1/realtime?model=grok-voice-latest`,{headers:{authorization:'Bearer client-key'}});
 const message=await new Promise((resolve,reject)=>{socket.once('message',data=>resolve(data.toString()));socket.once('error',reject);});assert.equal(message,'ok');socket.terminate();
});
