import {rollbackGeminiCache} from './gemini_cache_rollback.ts';
import {cachePatch} from './gemini_cache_expiry.ts';
import {readBody} from './validation.ts';
import {requestBodyLimit} from './request_limits.ts';
import {Database,HttpError} from './db.ts';
import {hashKey} from './validation.ts';
import {json} from './http.ts';
import {resolveGeminiCache} from './gemini_cache_reference.ts';
import {type Account} from './accounts.ts';
import {decryptSecret} from './credential_store.ts';
import {apiKeyRequest} from './api_key_provider.ts';
import {accountFetch} from './account_proxy.ts';
import type {ApiKeyCredentials} from './gateway.ts';

type Result=Record<string,any>;
export async function geminiCacheMutation(request:Request,path:string,token:string,db:Database):Promise<Response>{
 if(db.config.dataModel!=='native')throw new HttpError(501,'native_data_model_required');
 const name=path.slice('/v1beta/'.length);
 if(!/^cachedContents\/[a-zA-Z0-9_-]{1,64}$/.test(name))throw new HttpError(400,'invalid_cached_content');
 const keyHash=await hashKey(token),ip=request.headers.get('cf-connecting-ip')?.trim()||request.headers.get('x-real-ip')?.trim()||request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||null;
 const detail=await db.rpc<Result>('s2a_personal_cache_read',{p_key_hash:keyHash,p_name:name,p_client_ip:ip});
 if(detail?.error)throw new HttpError(detail.status??403,detail.error);
 if(typeof detail?.model!=='string')throw new HttpError(503,'invalid_cache_binding');
 const patch=request.method==='PATCH'?cachePatch(await readBody(request,requestBodyLimit(path,db.config.requestLimits)),new URL(request.url).searchParams.get('updateMask')??''):undefined;
 const model=detail.model.replace(/^models\//,'');
 const binding=await resolveGeminiCache(db,keyHash,name,model,ip);
 const reservation=await db.rpc<Result>('s2a_personal_acquire',{p_key_hash:keyHash,p_model:model,p_request_id:crypto.randomUUID(),p_excluded:[],p_count_request:true,p_client_ip:ip,p_billing_context:{policy_model:model,cached_content:name,count_only:true,stream:false}});
 if(reservation?.error)throw new HttpError(reservation.status??503,reservation.error);
 const account=reservation.account as Account;
 let status=502,completed=false,claimed=false,confirmed=false;
 try{
  if(!account||String(account.id)!==binding.account_id||account.platform!=='gemini')throw new HttpError(503,'cache_account_unavailable');
  const credentials=await decryptSecret(account,db.config.encryptionKey) as unknown as Record<string,unknown>;
  if(!('api_key' in credentials))throw new HttpError(501,'cache_account_type_unsupported');
  const base=typeof credentials.base_url==='string'?credentials.base_url.replace(/\/+$/,''):'';
  if(base&&base!=='https://generativelanguage.googleapis.com'&&credentials.explicit_cache_upstream!==true)throw new HttpError(501,'cache_upstream_unsupported');
  const upstreamMax=Number(credentials.explicit_cache_upstream_max_ttl_seconds);
  if(patch&&credentials.explicit_cache_upstream===true&&Number.isFinite(upstreamMax)&&upstreamMax>0&&Date.parse(patch.expireTime)-Date.now()>upstreamMax*1000)throw new HttpError(400,'cache_upstream_ttl_exceeded');
  const outgoing=apiKeyRequest('gemini',credentials as ApiKeyCredentials,'gemini','/v1beta/'+binding.upstream_name,undefined,request,AbortSignal.any([request.signal,AbortSignal.timeout(120000)]));
  const claim=await db.rpc<Result>('s2a_personal_cache_mutation',{p_key_hash:keyHash,p_name:name,p_lease_id:reservation.lease_id,p_action:'claim',p_client_ip:ip});
  if(claim?.error)throw new HttpError(claim.status??409,claim.error);
  if(claim?.claimed!==true)throw new HttpError(503,'cache_mutation_unavailable');
  claimed=true;
  if(claim.recover){
   const rollback=claim.rollback_expire_time;
   if(typeof rollback!=='string')throw new HttpError(503,'invalid_cache_recovery_state');
   if(await rollbackGeminiCache(db,account,credentials,binding.upstream_name,rollback,request,outgoing.init.signal!)){
    const forgotten=await db.rpc<Result>('s2a_personal_cache_deleted',{p_key_hash:keyHash,p_name:name,p_lease_id:reservation.lease_id,p_client_ip:ip});
    if(forgotten?.error)throw new HttpError(forgotten.status??503,forgotten.error);
    if(forgotten?.deleted!==true)throw new HttpError(503,'cache_recovery_persistence_failed');
    confirmed=true;
    if(patch)throw new HttpError(404,'cached_content_not_found');
    completed=true;status=200;return json(200,{});
   }
  }
  outgoing.init.method=patch?'PATCH':'DELETE';
  if(patch){
   outgoing.url+='?updateMask=expireTime';
   outgoing.init.body=JSON.stringify(patch);
  }
  const response=await accountFetch(db,account,outgoing.url,outgoing.init);status=response.status;
  confirmed=!response.ok&&response.status<500;
  let observed:string|undefined;
  if(patch&&response.ok){
   let metadata:Record<string,unknown>;
   try{metadata=await readBody(new Request('https://cache.invalid',{method:'POST',body:response.body,duplex:'half'} as RequestInit),1048576);}catch{throw new HttpError(502,'invalid_cache_upstream_response');}
   if(metadata.name!==binding.upstream_name||typeof metadata.expireTime!=='string'||!Number.isFinite(Date.parse(metadata.expireTime))||Date.parse(metadata.expireTime)<=Date.now())throw new HttpError(502,'invalid_cache_upstream_response');
   observed=metadata.expireTime;
  }else await response.body?.cancel();
  // A provider 404 confirms the resource is absent, including a retried deletion.
  if(!response.ok&&response.status!==404)throw new HttpError(response.status>=500?502:response.status,patch?'cached_content_patch_failed':'cached_content_delete_failed');
  if(patch&&response.status===404)await db.rpc<Result>('s2a_personal_cache_deleted',{p_key_hash:keyHash,p_name:name,p_lease_id:reservation.lease_id,p_client_ip:ip});
  if(patch&&!response.ok)throw new HttpError(response.status===404?404:response.status>=500?502:response.status,'cached_content_patch_failed');
  const saved=patch?await db.rpc<Result>('s2a_personal_cache_mutation',{p_key_hash:keyHash,p_name:name,p_lease_id:reservation.lease_id,p_action:'apply',p_expire_time:observed,p_client_ip:ip}):await db.rpc<Result>('s2a_personal_cache_deleted',{p_key_hash:keyHash,p_name:name,p_lease_id:reservation.lease_id,p_client_ip:ip});
  if(saved?.error)throw new HttpError(saved.status??503,saved.error);
  completed=true;status=200;
  if(patch){const view=await db.rpc<Result>('s2a_personal_cache_read',{p_key_hash:keyHash,p_name:name,p_client_ip:ip});if(view?.error)throw new HttpError(view.status??503,view.error);return json(200,view);}
  return json(200,{});
 }catch(error){
  if(error instanceof HttpError)throw error;
  throw new HttpError(502,patch?'cached_content_patch_failed':'cached_content_delete_failed');
 }finally{
  if(claimed&&(completed||confirmed)){
   try{const released=await db.rpc<Result>('s2a_personal_cache_mutation',{p_key_hash:keyHash,p_name:name,p_lease_id:reservation.lease_id,p_action:'release',p_client_ip:ip});
   if(released?.error)console.error('cache_mutation_release_failed');}catch{console.error('cache_mutation_release_failed');}
  }
  const finished=await db.rpc<Result>('s2a_personal_finish',{p_lease_id:reservation.lease_id,p_status:status,p_outcome:completed?'completed':'failed',p_input_tokens:null,p_output_tokens:null,p_cache_creation_tokens:null,p_cache_read_tokens:null,p_cooldown_seconds:0,p_credential_version:account?.credential_version??null,p_upstream_model:binding.upstream_model});
  if(finished?.error)throw new HttpError(finished.status??503,finished.error);
 }
}
