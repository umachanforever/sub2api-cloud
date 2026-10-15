import {responsesWebSocketMode} from './responses_ws_mode.ts';
import {bridgeInput,bridgeResponses,type BridgeHistory} from './responses_http_bridge.ts';
import NodeWebSocket,{type ClientOptions} from 'ws';
import {ProxyAgent} from 'proxy-agent';
import {Database,HttpError} from './db.ts';
import {hashKey} from './validation.ts';
import {type Account,credentialsFor} from './accounts.ts';
import {decryptApiKeyCredentials} from './credential_store.ts';
import {buildHeaders,CODEX_RESPONSES_URL,normalizeBody} from './gateway.ts';
import {currentCodexIdentity} from './codex_identity.ts';
import {defaultSolModel} from './codex_models.ts';
import {mappedTarget,type ModelSources} from './model_mapping.ts';
import {modelCandidates} from './model_policy.ts';
import {apiKeyRequest,nativeUsage} from './api_key_provider.ts';
import {resolveProxy} from './account_proxy.ts';
import type {Usage} from './stream.ts';
type Reservation={error?:string;status?:number;lease_id:string;account:Account&{type:string};model_sources?:ModelSources;upstream_model?:string};
type Upgrade=(request:Request)=>{response:Response;socket:WebSocket};
const MAX=32*1024*1024;
export async function openAIResponsesWebSocket(request:Request,token:string,db:Database,upgrade:Upgrade=request=>Deno.upgradeWebSocket(request),dial:(url:URL,options:ClientOptions)=>NodeWebSocket=(url,options)=>new NodeWebSocket(url,options)):Promise<Response>{
 if(request.headers.get('upgrade')?.toLowerCase()!=='websocket')throw new HttpError(426,'websocket_upgrade_required');
 const keyHash=await hashKey(token),clientIp=request.headers.get('cf-connecting-ip')?.trim()||request.headers.get('x-real-ip')?.trim()||request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||null;
 const policy=await db.rpc<{platform?:string;error?:string;status?:number}>('s2a_personal_key_policy',{p_key_hash:keyHash,p_client_ip:clientIp});
 if(!policy||policy.error)throw new HttpError(policy?.status??503,policy?.error??'database_unavailable');
 if(!['openai','grok'].includes(policy.platform??''))throw new HttpError(400,'responses_websocket_group_required');
 const {response,socket:client}=upgrade(request),signal=AbortSignal.any([request.signal,AbortSignal.timeout(120000)]);
 let upstream:NodeWebSocket|undefined,agent:ProxyAgent|undefined,ended=false,model:string|undefined,upstreamModel:string|undefined,pinned:Account|undefined;
 let history:BridgeHistory|undefined,sessionMode:string|undefined;
 let eventBytes=0,eventCount=0;
 let pending=0,pendingBytes=0,sequence=Promise.resolve(),events=Promise.resolve();
 let active:{reservation:Reservation;started:number;usage:Usage;settled?:Promise<void>;resolve:()=>void;done:Promise<void>}|undefined;
 let resolveLifetime!:()=>void;const lifetime=new Promise<void>(resolve=>{resolveLifetime=resolve;});
 const finish=(status:number,outcome:Usage['outcome']):Promise<void>=>{
  const turn=active;if(!turn)return Promise.resolve();
  if(turn.settled)return turn.settled;
  turn.settled=(async()=>{
   try{
    let saved=false;
    for(let attempt=0;attempt<2;attempt++){
     try{const result=await db.rpc<{error?:string}>('s2a_personal_finish',{p_lease_id:turn.reservation.lease_id,p_status:status,p_outcome:outcome==='incomplete'?'interrupted':outcome,p_input_tokens:turn.usage.input,p_output_tokens:turn.usage.output,p_cache_creation_tokens:turn.usage.cacheCreation,p_cache_read_tokens:turn.usage.cacheRead,p_cooldown_seconds:0,...(turn.usage.firstTokenMs===undefined?{}:{p_first_token_ms:turn.usage.firstTokenMs}),p_credential_version:turn.reservation.account.credential_version,p_upstream_model:upstreamModel??model});if(result?.error)throw Error('usage_write_failed');saved=true;break;}catch{if(attempt===0)await new Promise(resolve=>setTimeout(resolve,250));}
    }
    if(!saved)throw new HttpError(503,'usage_persistence_failed');
   }finally{if(active===turn)active=undefined;turn.resolve();}
  })();return turn.settled;
 };
 const close=async(code:number,status:number,outcome:Usage['outcome'])=>{
  if(ended)return;ended=true;signal.removeEventListener('abort',abort);
  try{if(client.readyState<2)client.close(code,code===1000?'':'Responses connection closed');}catch{}
  upstream?.terminate();agent?.destroy();
  try{await finish(status,outcome);}catch{console.warn('responses_ws_usage_persistence_failed');}finally{resolveLifetime();}
 };
 const fail=(error:unknown)=>{
  if(ended)return;
  try{client.send(JSON.stringify({type:'error',error:{type:'gateway_error',code:error instanceof HttpError?error.code:'responses_websocket_failed',message:'Responses WebSocket request failed'}}));}catch{}
  void close(error instanceof HttpError&&error.status<500?1008:1011,error instanceof HttpError?error.status:502,'failed');
 };
 const abort=()=>{const timeout=signal.reason instanceof DOMException&&signal.reason.name==='TimeoutError';void close(timeout?1011:1001,timeout?504:499,timeout?'failed':'cancelled');};
 signal.addEventListener('abort',abort,{once:true});
 const deliver=async(event:Record<string,any>,text:string)=>{
  if(active){if(event.type==='response.output_text.delta'&&typeof event.delta==='string'&&event.delta&&active.usage.firstTokenMs===undefined)active.usage.firstTokenMs=Math.min(2147483647,Date.now()-active.started);active.usage=nativeUsage(active.reservation.account.platform??'openai','responses',event,active.usage);if(['response.completed','response.done','response.failed','response.incomplete','error'].includes(event.type))await finish(event.type==='error'?502:200,event.type==='error'?'failed':event.type==='response.incomplete'?'incomplete':event.type==='response.failed'?'failed':'completed');}
  if(!ended){if(client.bufferedAmount+new TextEncoder().encode(text).length>MAX)throw new HttpError(502,'upstream_frame_too_large');client.send(text);}
 };
 const connect=async(reservation:Reservation,body:Record<string,unknown>)=>{
  const account=reservation.account;let headers:Headers,target:URL;
  if(account.type==='apikey'){
   const outgoing=apiKeyRequest('openai',await decryptApiKeyCredentials(account,db.config.encryptionKey),'responses','/v1/responses',body,request,signal);headers=new Headers(outgoing.init.headers);target=new URL(outgoing.url);
  }else{
   const credentials=await credentialsFor(db,account);headers=buildHeaders(credentials,await currentCodexIdentity(db,account,credentials));target=new URL(CODEX_RESPONSES_URL);
  }
  target.protocol='wss:';headers.set('openai-beta','responses_websockets=2026-02-06');headers.delete('content-type');headers.delete('accept');
  for(const name of ['session-id','thread-id','x-codex-window-id','x-codex-installation-id','x-client-request-id','x-codex-beta-features']){const value=request.headers.get(name);if(value&&value.length<=2000&&!/[\r\n]/.test(value))headers.set(name,value);}
  const transport=await resolveProxy(db,account.proxy_id,true);
  if(transport){const endpoint=new URL(`${transport.protocol}://${transport.host.includes(':')?'['+transport.host+']':transport.host}:${transport.port}`);endpoint.username=transport.username;endpoint.password=transport.password;agent=new ProxyAgent({getProxyForUrl:()=>endpoint.href});}
  signal.throwIfAborted();upstream=dial(target,{headers:Object.fromEntries(headers),agent,followRedirects:false,handshakeTimeout:15000,maxPayload:MAX,perMessageDeflate:false});
  upstream.on('error',()=>fail(new HttpError(502,'upstream_unavailable')));
  upstream.on('close',code=>{void close(code===1000?1000:1011,active?502:200,active?'incomplete':'completed');});
  upstream.on('message',(bytes,binary)=>{
   if(ended)return;
   const size=Array.isArray(bytes)?bytes.reduce((sum,chunk)=>sum+chunk.byteLength,0):bytes.byteLength;eventBytes+=size;eventCount++;
   if(eventBytes>MAX||eventCount>512){fail(new HttpError(502,'upstream_frame_too_large'));return;}
   events=events.then(async()=>{
    if(binary)throw new HttpError(502,'invalid_upstream_frame');
    const text=bytes.toString();if(new TextEncoder().encode(text).length>MAX||client.bufferedAmount+new TextEncoder().encode(text).length>MAX)throw new HttpError(502,'upstream_frame_too_large');
    const event=JSON.parse(text);
    await deliver(event,text);
   }).catch(fail).finally(()=>{eventBytes-=size;eventCount--;});
  });
  await new Promise<void>((resolve,reject)=>{
   const socket=upstream!;
   const cleanup=()=>{socket.removeListener('open',open);socket.removeListener('error',error);socket.removeListener('close',error);signal.removeEventListener('abort',cancel);};
   const open=()=>{cleanup();resolve();},error=()=>{cleanup();reject(new HttpError(502,'upstream_unavailable'));},cancel=()=>{cleanup();reject(new HttpError(499,'context_canceled'));};
   socket.once('open',open);socket.once('error',error);socket.once('close',error);signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
  });
 };
 const receive=async(text:string)=>{
  if(ended)return;signal.throwIfAborted();
  const payload=JSON.parse(text);if(!payload||typeof payload!=='object'||Array.isArray(payload)||payload.type!==undefined&&payload.type!=='response.create')throw new HttpError(400,'invalid_websocket_request');
  const requested=payload.model??model;if(typeof requested!=='string'||!requested.trim()||requested.length>200||/[\x00-\x1f\x7f]/.test(requested)||requested==='__models__')throw new HttpError(400,'invalid_model');
  if(model&&requested!==model)throw new HttpError(400,'model_change_requires_reconnect');model=requested;
  const requestId=crypto.randomUUID();
  const reservation=await db.rpc<Reservation>('s2a_personal_acquire',{p_key_hash:keyHash,p_model:model,p_request_id:requestId,p_excluded:[],p_count_request:true,p_client_ip:clientIp,p_billing_context:{policy_model:model,model_candidates:modelCandidates(model),native_stream:true,responses_websocket:true,inbound_endpoint:'/v1/responses',...(pinned?{websocket_account:pinned.id}:{})}});
  if(!reservation||reservation.error)throw new HttpError(reservation?.status??503,reservation?.error??'database_unavailable');
  let resolve!:()=>void;const done=new Promise<void>(r=>{resolve=r;});active={reservation,started:Date.now(),usage:{input:null,output:null,cacheCreation:null,cacheRead:null,outcome:'incomplete'},resolve,done};
  if(ended){await finish(499,'cancelled');return;}
  if(reservation.account.platform!==policy.platform||!['apikey','oauth'].includes(reservation.account.type)||pinned&&(reservation.account.id!==pinned.id||reservation.account.credential_version!==pinned.credential_version))throw new HttpError(409,'websocket_account_changed');
  const mapped=reservation.upstream_model??(reservation.model_sources?mappedTarget(reservation.model_sources.mapping,model,reservation.account.platform??'openai'):undefined)??model;
  const next=reservation.account.platform==='openai'?defaultSolModel(mapped)??mapped:mapped;if(upstreamModel&&next!==upstreamModel)throw new HttpError(409,'model_change_requires_reconnect');upstreamModel=next;
  let body:Record<string,unknown>={...payload,model:next};delete body.type;delete body.stream;
  if(reservation.account.type==='oauth'&&reservation.account.platform==='openai'){const input=body.input,empty=input===undefined||Array.isArray(input)&&!input.length;body=normalizeBody({...body,input:empty?[{role:'user',content:''}]:input});if(empty){if(input===undefined)delete body.input;else body.input=[];}delete body.stream;}
  const mode=responsesWebSocketMode(reservation.account);
  if(mode==='off')throw new HttpError(403,'websocket_disabled_for_account');
  if(sessionMode&&mode!==sessionMode)throw new HttpError(409,'websocket_mode_changed');sessionMode??=mode;
  pinned??=reservation.account;
  if(mode==='http_bridge'){
    const bridged=bridgeInput(body,history);if(new TextEncoder().encode(JSON.stringify(bridged)).length>MAX)throw new HttpError(413,'websocket_context_too_large');
    history=await bridgeResponses(db,reservation.account,bridged,request,signal,deliver)??history;
    return;
  }
  if(!upstream)await connect(reservation,body);
  if(ended||signal.aborted)return;
  const frame=JSON.stringify({...body,type:'response.create'});
  if(upstream!.bufferedAmount+new TextEncoder().encode(frame).length>MAX)throw new HttpError(400,'websocket_frame_too_large');
  await new Promise<void>((resolve,reject)=>upstream!.send(frame,error=>error?reject(error):resolve()));
  await done;
 };
 client.onmessage=event=>{
  if(ended)return;const text=event.data;
  if(typeof text!=='string'){fail(new HttpError(400,'invalid_websocket_frame'));return;}
  const bytes=new TextEncoder().encode(text).length;pending++;pendingBytes+=bytes;
  if(bytes>MAX||pending>4||pendingBytes>MAX){fail(new HttpError(413,'websocket_frame_too_large'));return;}
  sequence=sequence.then(()=>receive(text)).catch(fail).finally(()=>{pending--;pendingBytes-=bytes;});
 };
 client.onclose=()=>{void close(1000,499,'cancelled');};client.onerror=()=>{void close(1011,499,'cancelled');};
 const runtime=(globalThis as typeof globalThis&{EdgeRuntime?:{waitUntil(promise:Promise<unknown>):void}}).EdgeRuntime;runtime?.waitUntil(lifetime);
 if(signal.aborted)abort();
 return response;
}
