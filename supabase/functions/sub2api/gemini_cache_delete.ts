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
export async function geminiCacheDelete(request:Request,path:string,token:string,db:Database):Promise<Response>{
 if(db.config.dataModel!=='native')throw new HttpError(501,'native_data_model_required');
 const name=path.slice('/v1beta/'.length);
 if(!/^cachedContents\/[a-zA-Z0-9_-]{1,64}$/.test(name))throw new HttpError(400,'invalid_cached_content');
 const keyHash=await hashKey(token),ip=request.headers.get('cf-connecting-ip')?.trim()||request.headers.get('x-real-ip')?.trim()||request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||null;
 const detail=await db.rpc<Result>('s2a_personal_cache_read',{p_key_hash:keyHash,p_name:name,p_client_ip:ip});
 if(detail?.error)throw new HttpError(detail.status??403,detail.error);
 if(typeof detail?.model!=='string')throw new HttpError(503,'invalid_cache_binding');
 const model=detail.model.replace(/^models\//,'');
 const binding=await resolveGeminiCache(db,keyHash,name,model,ip);
 const reservation=await db.rpc<Result>('s2a_personal_acquire',{p_key_hash:keyHash,p_model:model,p_request_id:crypto.randomUUID(),p_excluded:[],p_count_request:true,p_client_ip:ip,p_billing_context:{policy_model:model,cached_content:name,count_only:true,stream:false}});
 if(reservation?.error)throw new HttpError(reservation.status??503,reservation.error);
 const account=reservation.account as Account;
 let status=502,completed=false;
 try{
  if(!account||String(account.id)!==binding.account_id||account.platform!=='gemini')throw new HttpError(503,'cache_account_unavailable');
  const credentials=await decryptSecret(account,db.config.encryptionKey) as unknown as Record<string,unknown>;
  if(!('api_key' in credentials))throw new HttpError(501,'cache_account_type_unsupported');
  const base=typeof credentials.base_url==='string'?credentials.base_url.replace(/\/+$/,''):'';
  if(base&&base!=='https://generativelanguage.googleapis.com'&&credentials.explicit_cache_upstream!==true)throw new HttpError(501,'cache_upstream_unsupported');
  const outgoing=apiKeyRequest('gemini',credentials as ApiKeyCredentials,'gemini','/v1beta/'+binding.upstream_name,undefined,request,AbortSignal.any([request.signal,AbortSignal.timeout(120000)]));
  outgoing.init.method='DELETE';
  const response=await accountFetch(db,account,outgoing.url,outgoing.init);status=response.status;
  await response.body?.cancel();
  // A provider 404 confirms the resource is absent, including a retried deletion.
  if(!response.ok&&response.status!==404)throw new HttpError(response.status>=500?502:response.status,'cached_content_delete_failed');
  const saved=await db.rpc<Result>('s2a_personal_cache_deleted',{p_key_hash:keyHash,p_name:name,p_lease_id:reservation.lease_id,p_client_ip:ip});
  if(saved?.error)throw new HttpError(saved.status??503,saved.error);
  completed=true;status=200;return json(200,{});
 }catch(error){
  if(error instanceof HttpError)throw error;
  throw new HttpError(502,'cached_content_delete_failed');
 }finally{
  const finished=await db.rpc<Result>('s2a_personal_finish',{p_lease_id:reservation.lease_id,p_status:status,p_outcome:completed?'completed':'failed',p_input_tokens:null,p_output_tokens:null,p_cache_creation_tokens:null,p_cache_read_tokens:null,p_cooldown_seconds:0,p_credential_version:account?.credential_version??null,p_upstream_model:binding.upstream_model});
  if(finished?.error)throw new HttpError(finished.status??503,finished.error);
 }
}
