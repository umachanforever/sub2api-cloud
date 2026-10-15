import {Database,HttpError} from './db.ts';
import {accountFetch} from './account_proxy.ts';
import type {Account} from './accounts.ts';
import type {ApiKeyCredentials} from './gateway.ts';
import {GeminiBatchClient} from './gemini_batch.ts';
import {VertexServiceAccountToken} from './vertex_auth.ts';
import {VertexBatchStorage} from './vertex_gcs.ts';
import type {BatchCleanupJob} from './batch_image_cleanup.ts';
export function batchProviderCleanup(db:Database,options:{vertex?:{bucket:string;environment?:string}}={}):(job:BatchCleanupJob,signal:AbortSignal)=>Promise<void>{
 return async(job,signal)=>{
  if(!/^imgbatch_[a-f0-9]{32}$/.test(job.batch_id)||! /^[1-9][0-9]{0,18}$/.test(String(job.account_id)))throw new HttpError(503,'invalid_batch_cleanup_account');
  if(job.provider==='gemini_api'&&!job.input_ref&&(!job.output_ref||job.output_ref==='gemini:pending'))return;
  const account=await db.rpc<Account&{type:string;credential_storage:'vault';credentials:Record<string,unknown>;error?:string}>('s2a_batch_image_cleanup_account',{p_id:job.batch_id,p_lease:job.cleanup_lease});
  if(!account||account.error||account.id!==String(job.account_id)||account.platform!=='gemini'||account.credential_storage!=='vault')throw new HttpError(503,'batch_cleanup_account_unavailable');
  if(job.provider==='gemini_api'){
   const client=new GeminiBatchClient(db,account,account.credentials as ApiKeyCredentials),refs=new Set([job.input_ref,job.output_ref].filter((ref):ref is string=>Boolean(ref)&&ref!=='gemini:pending'));
   for(const ref of refs)await client.deleteFile(ref,signal);
  }else if(job.provider==='vertex'){
   if(account.type!=='service_account'||!options.vertex?.bucket)throw new HttpError(503,'vertex_cleanup_configuration_required');
   const fetcher:typeof fetch=(input,init)=>accountFetch(db,account,input,init),tokens=new VertexServiceAccountToken(account.credentials,fetcher),storage=new VertexBatchStorage(options.vertex.bucket,job.batch_id,()=>tokens.accessToken(),fetcher,options.vertex.environment);
   if(job.input_ref&&job.input_ref!==storage.inputURI||job.output_ref&&!job.output_ref.startsWith(storage.outputURI))throw new HttpError(409,'vertex_cleanup_path_mismatch');
   await storage.deleteObject(storage.inputURI,signal);await storage.deleteOutputs(signal);
   if((await storage.listOutputs(signal,false)).length)throw new HttpError(503,'vertex_cleanup_incomplete');
  }else throw new HttpError(503,'invalid_batch_cleanup_provider');
 };
}
