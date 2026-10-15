import {Database,HttpError} from './db.ts';
import {type Account} from './accounts.ts';
import {decryptSecret} from './credential_store.ts';
import {authorizeJob} from './privacy_jobs.ts';
import {rollbackGeminiCache} from './gemini_cache_rollback.ts';
import {json} from './http.ts';
type Job={id:string;lease_id:string;upstream_name:string;expire_time:string;account:Account};
export async function geminiCacheJobs(request:Request,db:Database):Promise<Response>{
 await authorizeJob(request,db,'gemini-cache');
 if(db.config.dataModel!=='native')throw new HttpError(501,'native_data_model_required');
 const jobs=await db.rpc<Job[]>('s2a_personal_cache_jobs_claim',{});
 if(!Array.isArray(jobs)||jobs.length>3)throw new HttpError(503,'invalid_cache_jobs');
 let finished=0;
 await Promise.all(jobs.map(async job=>{
  let success=false,deleted=false;
  try{
   const credentials=await decryptSecret(job.account,db.config.encryptionKey);
   deleted=await rollbackGeminiCache(db,job.account,credentials,job.upstream_name,job.expire_time,request,AbortSignal.timeout(35000));
   success=true;
  }catch{console.warn('cache_recovery_pending');}
  try{
   if(await db.rpc<boolean>('s2a_personal_cache_jobs_finish',{p_id:job.id,p_lease_id:job.lease_id,p_success:success,p_deleted:deleted}))finished++;
  }catch{console.warn('cache_recovery_finish_failed');}
 }));
 return json(200,{claimed:jobs.length,finished});
}
