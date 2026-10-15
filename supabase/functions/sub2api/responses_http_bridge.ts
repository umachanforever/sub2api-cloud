import {Database,HttpError} from './db.ts';
import {type Account,credentialsFor} from './accounts.ts';
import {decryptApiKeyCredentials} from './credential_store.ts';
import {apiKeyRequest} from './api_key_provider.ts';
import {grokOAuthRequest} from './grok_oauth.ts';
import {buildHeaders,CODEX_RESPONSES_URL} from './gateway.ts';
import {currentCodexIdentity} from './codex_identity.ts';
import {accountFetch} from './account_proxy.ts';
type Item=Record<string,any>;
export type BridgeHistory={id:string;input:unknown[];output:unknown[]};
export function bridgeInput(body:Item,history?:BridgeHistory):Item{
 const result={...body};delete result.type;delete result.generate;result.stream=true;
 if(history&&result.previous_response_id===history.id){
  const current=typeof result.input==='string'?[{role:'user',content:result.input}]:result.input??[];
  if(!Array.isArray(current))throw new HttpError(400,'invalid_websocket_input');
  const prior=[...history.input,...history.output];
  result.input=prior.every((item,index)=>JSON.stringify(item)===JSON.stringify(current[index]))?current:[...prior,...current];
  delete result.previous_response_id;
 }
 return result;
}
export async function bridgeResponses(db:Database,account:Account&{type:string},body:Item,request:Request,signal:AbortSignal,emit:(event:Item,text:string)=>Promise<void>,onDispatch:(url:string)=>void=()=>{}):Promise<BridgeHistory|undefined>{
 const platform=account.platform??'openai';let url:string,init:RequestInit;
 if(account.type==='apikey')({url,init}=apiKeyRequest(platform,await decryptApiKeyCredentials(account,db.config.encryptionKey),'responses','/v1/responses',body,request,signal));
 else{
  const credentials=await credentialsFor(db,account);
  if(platform==='grok')({url,init}=grokOAuthRequest(credentials,'responses','/v1/responses',body,request,signal));
  else{url=CODEX_RESPONSES_URL;init={method:'POST',headers:buildHeaders(credentials,await currentCodexIdentity(db,account,credentials)),body:JSON.stringify(body),signal,redirect:'error'};}
 }
 onDispatch(url);
 const response=await accountFetch(db,account,url,init);
 if(!response.ok){await response.body?.cancel();throw new HttpError(response.status===429?429:502,'upstream_http');}
 if(!response.body)throw new HttpError(502,'invalid_upstream_response');
 const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',terminal=false,history:BridgeHistory|undefined;
 const accept=async(event:Item,text:string)=>{
  if(!event||typeof event!=='object'||Array.isArray(event)||typeof event.type!=='string')throw new HttpError(502,'invalid_upstream_event');
  if(['response.completed','response.done','response.failed','response.incomplete','error'].includes(event.type))terminal=true;
  if(['response.completed','response.done'].includes(event.type)&&typeof event.response?.id==='string'&&Array.isArray(event.response?.output)){
   const input=typeof body.input==='string'?[{role:'user',content:body.input}]:Array.isArray(body.input)?body.input:[];
   history={id:event.response.id,input,output:event.response.output};
   if(new TextEncoder().encode(JSON.stringify(history)).length>32*1024*1024)throw new HttpError(502,'websocket_context_too_large');
  }
  await emit(event,text);
 };
 try{
  if(response.headers.get('content-type')&&!response.headers.get('content-type')!.toLowerCase().includes('text/event-stream'))throw new HttpError(502,'invalid_upstream_stream');
  while(true){
   signal.throwIfAborted();const {done,value}=await reader.read();pending+=decoder.decode(value,{stream:!done});
   let boundary:RegExpExecArray|null;
   while((boundary=/\r?\n\r?\n/.exec(pending))){
    const frame=pending.slice(0,boundary.index);pending=pending.slice(boundary.index+boundary[0].length);
    if(frame.length>32*1024*1024)throw new HttpError(502,'upstream_frame_too_large');
    const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    if(data&&data!=='[DONE]'){await accept(JSON.parse(data),data);if(terminal)return history;}
   }
   if(pending.length>32*1024*1024)throw new HttpError(502,'upstream_frame_too_large');
   if(done)break;
  }
  if(pending.trim()||!terminal)throw new HttpError(502,'incomplete_upstream_stream');
  return history;
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
