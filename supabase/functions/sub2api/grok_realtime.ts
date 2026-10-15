import NodeWebSocket,{type ClientOptions} from 'ws';
import {ProxyAgent} from 'proxy-agent';
import type {TransportProxy} from './proxy_transport.ts';
import type {Usage} from './stream.ts';
import {HttpError} from './db.ts';
const MAX_BYTES=16*1024*1024;
type Upgrade=(request:Request)=>{response:Response;socket:WebSocket};
export async function relayGrokRealtime(request:Request,target:string,headers:Headers,proxy:TransportProxy|null,signal:AbortSignal,finish:(status:number,usage:Usage)=>Promise<void>,upgrade:Upgrade=request=>Deno.upgradeWebSocket(request),dial:(url:URL,options:ClientOptions)=>NodeWebSocket=(url,options)=>new NodeWebSocket(url,options)):Promise<Response>{
 const url=new URL(target);if(url.protocol!=='https:'||url.username||url.password)throw new HttpError(400,'invalid_realtime_target');url.protocol='wss:';
 let agent:ProxyAgent|undefined;
 if(proxy){const endpoint=new URL(`${proxy.protocol}://${proxy.host.includes(':')?'['+proxy.host+']':proxy.host}:${proxy.port}`);endpoint.username=proxy.username;endpoint.password=proxy.password;agent=new ProxyAgent({getProxyForUrl:()=>endpoint.href});}
 let upstream:NodeWebSocket;
 try{signal.throwIfAborted();upstream=dial(url,{headers:Object.fromEntries(headers),agent,followRedirects:false,handshakeTimeout:15000,maxPayload:MAX_BYTES,perMessageDeflate:false});}
 catch{agent?.destroy();throw new HttpError(502,'realtime_upstream_unavailable');}
 let client:WebSocket|undefined,ended=false,opened=false,queuedBytes=0;
 const queued:{data:string|ArrayBuffer;size:number}[]=[];
 let resolveDone!:()=>void;const done=new Promise<void>(resolve=>{resolveDone=resolve;});
 const end=async(code:number,status:number,outcome:Usage['outcome'])=>{
  if(ended)return;ended=true;signal.removeEventListener('abort',abort);
  try{if(client&&client.readyState<2)client.close(code,code===1000?'':'Realtime connection closed');}catch{}
  upstream.terminate();agent?.destroy();queued.length=0;
  try{await finish(status,{input:null,output:null,cacheCreation:null,cacheRead:null,outcome});}catch{console.warn('realtime_usage_persistence_failed');}finally{resolveDone();}
 };
 const abort=()=>{void end(1001,499,'cancelled');};
 signal.addEventListener('abort',abort,{once:true});
 upstream.on('error',()=>{void end(1011,502,'failed');});
 upstream.on('close',code=>{void end(code===1000?1000:1011,code===1000?200:502,code===1000?'completed':'failed');});
 upstream.binaryType='arraybuffer';
 upstream.on('message',(raw,binary)=>{
  if(ended)return;const data=binary?new Uint8Array(raw as ArrayBuffer).buffer:raw.toString(),size=typeof data==='string'?new TextEncoder().encode(data).length:data.byteLength;
  if(size>MAX_BYTES){void end(1009,502,'failed');return;}
  if(!opened){queuedBytes+=size;if(queuedBytes>MAX_BYTES||queued.length>=128){void end(1009,502,'failed');return;}queued.push({data,size});return;}
  if(!client||client.bufferedAmount+size>MAX_BYTES){void end(1009,502,'failed');return;}
  try{client.send(data);}catch{void end(1011,502,'failed');}
 });
 try{
  await new Promise<void>((resolve,reject)=>{
   const cleanup=()=>{upstream.removeListener('open',onOpen);upstream.removeListener('error',fail);upstream.removeListener('close',fail);signal.removeEventListener('abort',onAbort);};
   const fail=()=>{cleanup();reject(new HttpError(502,'realtime_upstream_unavailable'));};
   const onAbort=()=>{cleanup();reject(new HttpError(504,'realtime_connect_cancelled'));};
   const onOpen=()=>{cleanup();upstream.pause();resolve();};
   upstream.once('open',onOpen);upstream.once('error',fail);upstream.once('close',fail);signal.addEventListener('abort',onAbort,{once:true});
   if(signal.aborted)onAbort();
  });
  if(ended)throw new HttpError(502,'realtime_upstream_unavailable');
  signal.throwIfAborted();const upgraded=upgrade(request);client=upgraded.socket;client.binaryType='arraybuffer';
  client.onopen=()=>{if(ended){try{client?.close(1001);}catch{}return;}opened=true;try{for(const item of queued)client!.send(item.data);queued.length=0;queuedBytes=0;upstream.resume();}catch{void end(1011,502,'failed');}};
  client.onmessage=event=>{if(ended)return;const data=event.data,size=typeof data==='string'?new TextEncoder().encode(data).length:data instanceof ArrayBuffer?data.byteLength:MAX_BYTES+1;if(size>MAX_BYTES||upstream.bufferedAmount+size>MAX_BYTES){void end(1009,400,'failed');return;}upstream.send(data,{binary:typeof data!=='string'},error=>{if(error)void end(1011,502,'failed');});};
  client.onclose=event=>{void end(event.code===1000?1000:1001,event.code===1000?200:499,event.code===1000?'completed':'cancelled');};
  client.onerror=()=>{void end(1011,499,'cancelled');};
  const runtime=(globalThis as typeof globalThis&{EdgeRuntime?:{waitUntil(promise:Promise<unknown>):void}}).EdgeRuntime;runtime?.waitUntil(done);
  return upgraded.response;
 }catch(error){await end(1011,signal.aborted?499:502,signal.aborted?'cancelled':'failed');throw error instanceof HttpError?error:new HttpError(502,'realtime_upstream_unavailable');}
}
