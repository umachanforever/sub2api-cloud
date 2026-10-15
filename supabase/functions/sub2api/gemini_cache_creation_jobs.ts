import {Database,HttpError} from './db.ts';
import {type Account} from './accounts.ts';
import {decryptSecret} from './credential_store.ts';
import {apiKeyRequest} from './api_key_provider.ts';
import {accountFetch} from './account_proxy.ts';
import {readBody} from './validation.ts';
import type {ApiKeyCredentials} from './gateway.ts';
export type CreationJob={public_id:string;lease_id:string;upstream_model:string;page_token:string|null;account:Account};

export async function cleanupCacheCreation(db:Database,job:CreationJob,request:Request):Promise<boolean>{
 let complete=false,next=job.page_token;
 try{
  if(!/^[a-f0-9]{40}$/.test(job.public_id)||!/^[a-zA-Z0-9._-]{1,200}$/.test(job.upstream_model)||job.account.platform!=='gemini')throw new HttpError(503,'invalid_cache_cleanup_job');
  const credentials=await decryptSecret(job.account,db.config.encryptionKey);
  if(typeof credentials.api_key!=='string')throw new HttpError(501,'cache_account_type_unsupported');
  const signal=AbortSignal.timeout(35000),seen=new Set<string>();
  for(let page=0;page<5;page++){
   const outgoing=apiKeyRequest('gemini',credentials as ApiKeyCredentials,'gemini','/v1beta/cachedContents',undefined,request,signal);
   const query=new URLSearchParams({pageSize:'20'});if(next)query.set('pageToken',next);
   const response=await accountFetch(db,job.account,outgoing.url+'?'+query,outgoing.init);
   if(response.status===400&&next){await response.body?.cancel();next=null;break;}
   if(!response.ok){await response.body?.cancel();throw new HttpError(502,'cache_creation_list_failed');}
   let body:Record<string,any>;
   try{body=await readBody(new Request('https://cache.invalid',{method:'POST',body:response.body,duplex:'half'} as RequestInit),4*1048576);}catch{throw new HttpError(502,'invalid_cache_cleanup_response');}
   if(body.error)throw new HttpError(502,'invalid_cache_cleanup_response');
   if(body.cachedContents!==undefined&&(!Array.isArray(body.cachedContents)||body.cachedContents.length>1000))throw new HttpError(502,'invalid_cache_cleanup_response');
   let removedAny=false;
   for(const item of body.cachedContents??[]){
    // Provider lists are private to recovery; delete only this intent's exact tag and model.
    if(item?.displayName!=='s2a-'+job.public_id||item.model!=='models/'+job.upstream_model)continue;
    if(typeof item.name!=='string'||!/^cachedContents\/[a-zA-Z0-9_-]{1,480}$/.test(item.name))throw new HttpError(502,'invalid_cache_cleanup_response');
    const removal=apiKeyRequest('gemini',credentials as ApiKeyCredentials,'gemini','/v1beta/'+item.name,undefined,request,signal);removal.init.method='DELETE';
    const removed=await accountFetch(db,job.account,removal.url,removal.init);await removed.body?.cancel();
    if(!removed.ok&&removed.status!==404)throw new HttpError(502,'cache_creation_cleanup_failed');
    removedAny=true;
   }
   // Restart after deletion so provider offset cursors cannot skip another tagged resource.
   if(removedAny){next=null;seen.clear();continue;}
   const token=body.nextPageToken;
   if(token===undefined||token===null||token===''){complete=true;next=null;break;}
   if(typeof token!=='string'||token.length>2048||seen.has(token))throw new HttpError(502,'invalid_cache_cleanup_cursor');
   seen.add(token);next=token;
  }
  return await db.rpc<boolean>('s2a_personal_cache_creations_finish',{p_public_id:job.public_id,p_lease_id:job.lease_id,p_complete:complete,p_page_token:next});
 }catch{console.warn('cache_creation_recovery_pending');return false;}
}
