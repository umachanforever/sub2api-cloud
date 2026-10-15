import {Database,HttpError} from './db.ts';
import {hashKey,readBody} from './validation.ts';
import {requestBodyLimit} from './request_limits.ts';
import {credentialsFor,type Account} from './accounts.ts';
import {decryptApiKeyCredentials} from './credential_store.ts';
import {apiKeyRequest} from './api_key_provider.ts';
import {grokOAuthRequest} from './grok_oauth.ts';
import {accountFetch} from './account_proxy.ts';
import {mappedTarget} from './model_mapping.ts';
import {json} from './http.ts';
import {signedVideoURL,videoRange,videoContentResponse,publicVideoContentURL} from './grok_video_content.ts';
import type {ErrorContext} from './ops_errors.ts';
type Item=Record<string,any>;
export class VideoTaskError extends HttpError {
 taskId:string;
 constructor(status:number,code:string,taskId:string){super(status,code);this.taskId=taskId;}
}
const taskId=/^video_[a-f0-9]{40}$/;
export function videoRoute(path:string,method:string){
 const create=/^\/(?:v1\/)?videos(?:\/(generations|edits|extensions))?$/.exec(path);
 if(method==='POST'&&create)return {operation:create[1]??'generations'};
 const lookup=/^\/(?:v1\/)?videos(?:\/(generations|edits|extensions))?\/([^/]+)(\/content)?$/.exec(path);
 if(method==='GET'&&lookup)return {operation:lookup[1],id:lookup[2],content:!!lookup[3]};
 return undefined;
}
export function videoInput(body:Item,operation:string):Item{
 const model=typeof body.model==='string'?body.model.trim():'';
 if(!/^[a-zA-Z0-9._-]{1,200}$/.test(model)||body.stream===true)throw new HttpError(400,'invalid_video_model');
 if((body.prompt!==undefined||operation!=='extensions')&&(typeof body.prompt!=='string'||!body.prompt.trim()||body.prompt.length>65536))throw new HttpError(400,'invalid_video_prompt');
 const out:Item={...body,model};delete out.stream;
 if(operation!=='generations'&&(!body.video||typeof body.video!=='object'||Array.isArray(body.video)||typeof body.video.url!=='string'||!body.video.url.trim()))throw new HttpError(400,'video_input_required');
 if(operation==='generations')for(const key of ['image','images','reference_images']){
  const value=out[key];if(value===undefined)continue;
  const reference=(entry:any)=>{
   if(typeof entry==='string'&&entry.trim())return {url:entry.trim()};
   if(!entry||typeof entry!=='object'||Array.isArray(entry)||'file_id' in entry)throw new HttpError(400,'invalid_video_image');
   const url=entry.url??entry.image_url;
   if(typeof url!=='string'||!url.trim())throw new HttpError(400,'invalid_video_image');
   const result={...entry,url:url.trim()};delete result.image_url;return result;
  };
  out[key]=Array.isArray(value)?value.map(reference):reference(value);
 }
 return out;
}
async function responseJson(response:Response):Promise<Item>{
 if(!response.body)throw new HttpError(502,'invalid_video_upstream_response');
 const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>4*1024*1024)throw new HttpError(502,'video_upstream_response_too_large');chunks.push(part.value);}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 try{const value=JSON.parse(new TextDecoder().decode(bytes));if(!value||typeof value!=='object'||Array.isArray(value)||value.error)throw Error();return value;}
 catch{throw new HttpError(502,'invalid_video_upstream_response');}
}
export function providerVideoId(value:Item):string{
 for(const item of [value,value.data,value.video])for(const key of ['request_id','id','task_id'])if(typeof item?.[key]==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(item[key]))return item[key];
 throw new HttpError(502,'invalid_video_upstream_response');
}
function publicVideo(value:Item,id:string,model:string,request:Request):Item{
 const out:Item={id,request_id:id,model};
 for(const key of ['status','created_at','duration','resolution','progress','expires_at'])if(['string','number'].includes(typeof value[key]))out[key]=value[key];
 // Provider URLs are visible only after the owning key has resolved the task.
 if(value.video&&typeof value.video==='object'&&!Array.isArray(value.video)){
  out.video={};for(const key of ['url','duration','resolution','respect_moderation'])if(['string','number','boolean'].includes(typeof value.video[key]))out.video[key]=key==='url'?publicVideoContentURL(request,id):value.video[key];
 }
 return out;
}
export async function grokVideo(request:Request,path:string,token:string,db:Database,context?:ErrorContext):Promise<Response>{
 if(db.config.dataModel!=='native')throw new HttpError(501,'native_data_model_required');
 const route=videoRoute(path,request.method);if(!route)throw new HttpError(404,'not_found');
 const keyHash=await hashKey(token),ip=request.headers.get('cf-connecting-ip')?.trim()||request.headers.get('x-real-ip')?.trim()||request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||null;
 if(context)Object.assign(context,{keyHash,platform:'grok',stream:false,endpoint:route.id?'/v1/videos/:id':'/v1/videos/'+route.operation});
 const checked=async(name:string,args:Item)=>{const result=await db.rpc<Item>(name,args);if(!result)throw new HttpError(503,'database_unavailable');if(result.error)throw new HttpError(result.status??503,result.error);return result;};
 // Only replay idempotent database writes, never uncertain provider submissions.
 const durable=async(name:string,args:Item,flag:string)=>{
  for(let attempt=0;attempt<2;attempt++){
   try{
    const result=await checked(name,args);
    if(flag==='applied'?typeof result.applied!=='boolean':result[flag]!==true)throw new HttpError(503,'invalid_video_task_persistence');
    return result;
   }catch(error){
    if(error instanceof HttpError&&error.status!==503)throw error;
    if(attempt===1)throw error instanceof HttpError?error:new HttpError(503,'database_unavailable');
   }
  }
  throw new HttpError(503,'database_unavailable');
 };
 const policy=await checked('s2a_personal_key_policy',{p_key_hash:keyHash,p_client_ip:ip});
 if(policy.platform!=='grok'){await request.body?.cancel().catch(()=>{});throw new HttpError(400,'grok_video_requires_grok_group');}
 const range=route.content?videoRange(request):undefined;
 if(route.id&&!taskId.test(route.id))throw new HttpError(400,'invalid_video_task');
 const binding=route.id?await checked('s2a_personal_video_resolve',{p_key_hash:keyHash,p_public_id:route.id,p_client_ip:ip}):undefined;
 if(binding&&route.operation&&binding.operation!==route.operation)throw new HttpError(404,'video_task_not_found');
 if(binding&&binding.state!=='submitted'&&route.content)throw new HttpError(409,'video_task_not_submitted');
 if(binding&&binding.state!=='submitted')return json(200,{id:route.id,request_id:route.id,model:binding.model,status:binding.state==='rejected'?'failed':'creation_unknown'});
 const input=binding?undefined:videoInput(await readBody(request,requestBodyLimit(path,db.config.requestLimits)),route.operation!);
 const model=binding?.model??input!.model;
 const reservation=await checked('s2a_personal_acquire',{p_key_hash:keyHash,p_model:model,p_request_id:crypto.randomUUID(),p_client_ip:ip,p_billing_context:{policy_model:model,stream:false,...(binding?{video_task:route.id,count_only:true}:{})}});
 const account=reservation.account as Account&{type:string};let status=502,completed=false,dispatched=false,intentAttempted=false,deferred=false;
 const id=route.id??'video_'+crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','').slice(0,8);
 const upstreamModel=binding?.upstream_model??reservation.upstream_model??mappedTarget(reservation.model_sources?.mapping??{},model,'grok')??model;
 const signal=AbortSignal.any([request.signal,AbortSignal.timeout(120000)]);
 if(context)Object.assign(context,{accountId:account?.id,leaseId:reservation.lease_id,model,upstreamModel});
 const finish=(responseStatus:number,usage:import('./stream.ts').Usage)=>durable('s2a_personal_finish',{p_lease_id:reservation.lease_id,p_status:responseStatus,p_outcome:usage.outcome==='incomplete'?'interrupted':usage.outcome,p_input_tokens:null,p_output_tokens:null,p_cache_creation_tokens:null,p_cache_read_tokens:null,p_cooldown_seconds:responseStatus===429?30:0,p_credential_version:account?.credential_version??null,p_upstream_model:upstreamModel},'applied').then(()=>{});
 const record=(action:string,upstreamId?:string)=>durable('s2a_personal_video_create',{p_key_hash:keyHash,p_public_id:id,p_lease_id:reservation.lease_id,p_upstream_model:upstreamModel,p_operation:route.operation,p_action:action,p_upstream_id:upstreamId??null,p_client_ip:ip},action==='prepare'?'prepared':action==='bind'?'bound':'rejected');
 try{
  if(account?.platform!=='grok')throw new HttpError(503,'video_account_unavailable');
  if(binding&&String(account.id)!==String(binding.account_id))throw new HttpError(503,'video_account_mismatch');
  let credentials=account.type==='apikey'?await decryptApiKeyCredentials(account,db.config.encryptionKey):await credentialsFor(db,account);
  const endpoint=binding?'/v1/videos/'+encodeURIComponent(binding.upstream_id):'/v1/videos/'+route.operation;
  const body=input?{...input,model:upstreamModel}:undefined;
  const forward=(target=endpoint,content=false)=>{
   const outgoing=account.type==='apikey'?apiKeyRequest('grok',credentials as any,'videos',target,body,request,signal):grokOAuthRequest(credentials as any,'videos',target,body,request,signal);
   if(content){const headers=new Headers(outgoing.init.headers);headers.set('accept','*/*');if(range)headers.set('range',range);outgoing.init.headers=headers;}
   return accountFetch(db,account,outgoing.url,outgoing.init);
  };
  if(!binding){intentAttempted=true;await record('prepare');}
  dispatched=true;
  let response=await forward();
  if(response.status===401&&account.type!=='apikey'){
   await response.body?.cancel();
   credentials=await credentialsFor(db,account,(credentials as {access_token:string}).access_token);
   response=await forward();
  }
  status=response.status;
  if(!response.ok){
   await response.body?.cancel();
   if(!binding&&status>=400&&status<500)await record('reject');
   throw new HttpError(status>=400&&status<500?status:502,'video_upstream_rejected');
  }
  const value=await responseJson(response);
  if(route.content){
   const signed=signedVideoURL(value.video?.url,binding!.upstream_id);
   const headers=new Headers({accept:'*/*'});if(range)headers.set('range',range);
   let download=signed?await accountFetch(db,account,signed,{method:'GET',headers,signal,redirect:'error'}):await forward(endpoint+'/content',true);
   if(!signed&&download.status===401&&account.type!=='apikey'){
    await download.body?.cancel();credentials=await credentialsFor(db,account,(credentials as {access_token:string}).access_token);download=await forward(endpoint+'/content',true);
   }
   status=download.status;
   if(!download.ok&&status!==416){await download.body?.cancel();throw new HttpError(status>=400&&status<500?status:502,'video_content_rejected');}
   const result=videoContentResponse(download,signal,finish);deferred=true;return result;
  }
  if(!binding)await record('bind',providerVideoId(value));
  completed=true;
  return json(response.status,publicVideo(value,id,model,request));
 }catch(error){
  const failure=error instanceof HttpError?error:request.signal.aborted?new HttpError(499,'request_cancelled'):signal.aborted?new HttpError(504,'video_request_timeout'):new HttpError(502,dispatched?'video_upstream_failed':'video_request_failed');
  status=failure.status;
  throw intentAttempted?new VideoTaskError(status,failure.code,id):failure;
 }finally{
  if(!deferred){
   try{await finish(status,{input:null,output:null,cacheCreation:null,cacheRead:null,outcome:completed?'completed':'failed'});}
   catch{throw intentAttempted||binding?new VideoTaskError(503,'video_task_persistence_failed',id):new HttpError(503,'video_task_persistence_failed');}
  }
 }
}
