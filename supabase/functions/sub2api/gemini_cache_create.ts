import {Database,HttpError} from './db.ts';
import {hashKey,readBody} from './validation.ts';
import {cachePatch} from './gemini_cache_expiry.ts';
import {requestBodyLimit} from './request_limits.ts';
import {decryptSecret} from './credential_store.ts';
import {type Account} from './accounts.ts';
import {apiKeyRequest} from './api_key_provider.ts';
import {accountFetch} from './account_proxy.ts';
import {mappedTarget} from './model_mapping.ts';
import {json} from './http.ts';
import type {ApiKeyCredentials} from './gateway.ts';
type Item=Record<string,any>;
export function cacheCreateInput(input:Item,now=Date.now()){
 const body=structuredClone(input);
 for(const [alias,key] of Object.entries({display_name:'displayName',expire_time:'expireTime',create_time:'createTime',update_time:'updateTime',usage_metadata:'usageMetadata'})){
  if(alias in body){if(key in body)throw new HttpError(400,'conflicting_cache_field');body[key]=body[alias];delete body[alias];}
 }
 const model=typeof body.model==='string'?body.model.trim().replace(/^models\//,''):'';
 if(!/^[a-zA-Z0-9._-]{1,200}$/.test(model))throw new HttpError(400,'invalid_cache_model');
 const displayName=body.displayName??'';
 if(typeof displayName!=='string'||[...displayName].length>128)throw new HttpError(400,'invalid_cache_display_name');
 const explicit=body.ttl!=null||body.expireTime!=null;
 const expiry=cachePatch(explicit?{ttl:body.ttl,expireTime:body.expireTime}:{ttl:'3600s'},'',now);
 const seconds=Math.ceil((Date.parse(expiry.expireTime)-now)/1000);
 for(const key of ['name','model','displayName','ttl','expireTime','createTime','updateTime','usageMetadata'])delete body[key];
 return {body,model,displayName,seconds,explicit};
}
export async function geminiCacheCreate(request:Request,token:string,db:Database):Promise<Response>{
 if(db.config.dataModel!=='native')throw new HttpError(501,'native_data_model_required');
 const keyHash=await hashKey(token),ip=request.headers.get('cf-connecting-ip')?.trim()||request.headers.get('x-real-ip')?.trim()||request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||null;
 const policy=await db.rpc<Item>('s2a_personal_key_policy',{p_key_hash:keyHash,p_client_ip:ip});
 if(policy?.error)throw new HttpError(policy.status??403,policy.error);
 if(policy?.platform!=='gemini')throw new HttpError(400,'gemini_cache_requires_gemini_group');
 const input=cacheCreateInput(await readBody(request,requestBodyLimit('/v1beta/cachedContents',db.config.requestLimits)));
 const excluded:string[]=[],requestId=crypto.randomUUID();
 for(let attempt=0;attempt<3;attempt++){
  const reservation=await db.rpc<Item>('s2a_personal_acquire',{p_key_hash:keyHash,p_model:input.model,p_request_id:requestId,p_excluded:excluded,p_count_request:attempt===0,p_client_ip:ip,p_billing_context:{policy_model:input.model,cache_create:true,count_only:true,stream:false}});
  if(reservation?.error)throw new HttpError(reservation.status??503,reservation.error);
  const account=reservation.account as Account;let completed=false,status=502,retry=false;
  try{
   if(account?.platform!=='gemini')throw new HttpError(503,'cache_account_unavailable');
   const credentials=await decryptSecret(account,db.config.encryptionKey);
   if(typeof credentials.api_key!=='string')throw new HttpError(501,'cache_account_type_unsupported');
   const upstreamModel=(mappedTarget(reservation.model_sources?.mapping??{},input.model,'gemini')??input.model).replace(/^models\//,'');
   if(!/^[a-zA-Z0-9._-]{1,200}$/.test(upstreamModel))throw new HttpError(400,'invalid_cache_model_mapping');
   const publicId=Array.from(crypto.getRandomValues(new Uint8Array(20)),v=>v.toString(16).padStart(2,'0')).join('');
   const body={...input.body,model:'models/'+upstreamModel,ttl:input.seconds+'s',displayName:'s2a-'+publicId};
   const outgoing=apiKeyRequest('gemini',credentials as ApiKeyCredentials,'gemini','/v1beta/cachedContents',body,request,AbortSignal.any([request.signal,AbortSignal.timeout(120000)]));
   const args={p_key_hash:keyHash,p_public_id:publicId,p_lease_id:reservation.lease_id,p_upstream_model:upstreamModel,p_display_name:input.displayName,p_client_ip:ip};
   const prepared=await db.rpc<Item>('s2a_personal_cache_create',{...args,p_action:'prepare'});
   if(prepared?.error)throw new HttpError(prepared.status??503,prepared.error);
   if(prepared?.prepared!==true)throw new HttpError(503,'cache_creation_unavailable');
   const response=await accountFetch(db,account,outgoing.url,outgoing.init);status=response.status;
   if(!response.ok){await response.body?.cancel();retry=[401,403,429].includes(status)||status>=500;throw new HttpError(status>=500?502:status,'cached_content_create_failed');}
   let metadata:Item;
   try{metadata=await readBody(new Request('https://cache.invalid',{method:'POST',body:response.body,duplex:'half'} as RequestInit),4*1048576);}catch{throw new HttpError(502,'invalid_cache_upstream_response');}
   const validName=typeof metadata.name==='string'&&/^cachedContents\/[a-zA-Z0-9_-]{1,480}$/.test(metadata.name);
   if(!validName||typeof metadata.expireTime!=='string'||!Number.isFinite(Date.parse(metadata.expireTime))||Date.parse(metadata.expireTime)<=Date.now()||Date.parse(metadata.expireTime)>Date.now()+86405000||!Number.isSafeInteger(metadata.usageMetadata?.totalTokenCount)||metadata.usageMetadata.totalTokenCount<=0){
    // No binding has been committed: safely remove a named but unusable resource.
    if(validName){
     try{
      const cleanup=apiKeyRequest('gemini',credentials as ApiKeyCredentials,'gemini','/v1beta/'+metadata.name,undefined,request,AbortSignal.timeout(20000));
      cleanup.init.method='DELETE';
      const removed=await accountFetch(db,account,cleanup.url,cleanup.init);await removed.body?.cancel();
      if(removed.ok||removed.status===404)await db.rpc<Item>('s2a_personal_cache_create',{...args,p_action:'abandon'});
     }catch{console.error('cache_creation_cleanup_pending');}
    }
    throw new HttpError(502,'invalid_cache_upstream_response');
   }
   let saved:Item|undefined;
   for(let persist=0;persist<2;persist++){
    try{saved=await db.rpc<Item>('s2a_personal_cache_create',{...args,p_action:'complete',p_upstream_name:metadata.name,p_expire_time:metadata.expireTime,p_token_count:metadata.usageMetadata.totalTokenCount});if(saved?.error)throw new HttpError(saved.status??503,saved.error);if(saved?.created!==true)throw new HttpError(503,'cache_creation_persistence_failed');break;}
    catch(error){if(persist===1)throw error;}
   }
   completed=true;status=200;
   const view=await db.rpc<Item>('s2a_personal_cache_read',{p_key_hash:keyHash,p_name:'cachedContents/'+publicId,p_client_ip:ip});
   if(view?.error)throw new HttpError(view.status??503,view.error);
   return json(200,view);
  }catch(error){
   if(!retry||attempt===2){if(error instanceof HttpError)throw error;throw new HttpError(502,'cached_content_create_failed');}
   excluded.push(String(account.id));
  }finally{
   const result=await db.rpc<Item>('s2a_personal_finish',{p_lease_id:reservation.lease_id,p_status:status,p_outcome:completed?'completed':'failed',p_input_tokens:null,p_output_tokens:null,p_cache_creation_tokens:null,p_cache_read_tokens:null,p_cooldown_seconds:0,p_credential_version:account?.credential_version??null,p_upstream_model:null});
   if(result?.error)throw new HttpError(result.status??503,result.error);
  }
 }
 throw new HttpError(503,'no_available_account');
}
