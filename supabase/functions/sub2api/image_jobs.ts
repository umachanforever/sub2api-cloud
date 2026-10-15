import {Database,HttpError} from './db.ts';
import {getArtifact,imageArtifactPath,deleteArtifacts,listTaskArtifacts} from './artifact_storage.ts';
import {imageBytesHash} from './image_task_submit.ts';
import {boundedImageBytes,loadImageManifest,storeImageResult} from './image_task_result.ts';
import {proxyImageJob,type ImageJobIdentity} from './proxy.ts';
import {authorizeJob} from './privacy_jobs.ts';
import {json} from './http.ts';
export type ImageJob=ImageJobIdentity&{recover:boolean;content_type:string;body_hash:string;body_size:number;request_path:string;result_path:string};
function validateJob(job:ImageJob):void{
 if(!job||!/^imgtask_[a-f0-9]{32}$/.test(job.id)||!/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(job.lease_id)||!/^[a-f0-9]{64}$/.test(job.key_hash)||!['openai','grok'].includes(job.platform)||!['generations','edits'].includes(job.operation)||typeof job.recover!=='boolean'||typeof job.model!=='string'||!/^[a-zA-Z0-9._:-]{1,200}$/.test(job.model)||typeof job.content_type!=='string'||job.content_type.length>512||/[\r\n\x00]/.test(job.content_type)||!/^application\/json(?:;|$)|^multipart\/form-data(?:;|$)/i.test(job.content_type)||!/^[a-f0-9]{64}$/.test(job.body_hash)||!Number.isSafeInteger(job.body_size)||job.body_size<1||job.body_size>256*1024*1024||job.client_ip!==null&&typeof job.client_ip!=='string'||job.request_path!==imageArtifactPath(job.id,'request')||job.result_path!==imageArtifactPath(job.id,'result','json'))throw new HttpError(503,'invalid_image_jobs');
}
async function jobRPC(db:Database,name:string,args:Record<string,unknown>):Promise<Record<string,unknown>>{
 for(let attempt=0;;attempt++){
  try{
   const value=await db.rpc<Record<string,unknown>|null>(name,args);
   if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(503,'invalid_image_job_response');
   if(typeof value.error==='string')throw new HttpError(typeof value.status==='number'?value.status:503,value.error);
   return value;
  }catch(error){if(attempt===1||error instanceof HttpError&&error.status!==503)throw error;}
 }
}
async function finish(db:Database,job:ImageJob,status:number,error:string|null,hash:string|null):Promise<boolean>{
 const saved=await jobRPC(db,'s2a_personal_image_job_finish',{p_id:job.id,p_lease_id:job.lease_id,p_http_status:status,p_error_code:error,p_result_hash:hash});
 if(typeof saved.applied!=='boolean')throw new HttpError(503,'invalid_image_job_response');return true;
}
export async function executeImageJob(db:Database,job:ImageJob):Promise<boolean>{
 validateJob(job);
 // The lease lasts 180s; stop storage and inference before another worker can reclaim it.
 const signal=AbortSignal.timeout(125000);
 let phase:'input'|'start'|'inference'|'storage'='input';
 try{
  if(job.recover){
   try{
    const {manifest,hash}=await loadImageManifest(db,job.id,signal,{model:job.model,operation:job.operation});
    return await finish(db,job,manifest.http_status,null,hash);
   }catch(error){
    if(error instanceof HttpError&&[404,502].includes(error.status))return await finish(db,job,502,'image_task_execution_unknown',null);
    throw error;
   }
  }
  const response=await getArtifact(db,job.request_path,signal),bytes=await boundedImageBytes(response,job.body_size);
  if(bytes.length!==job.body_size||await imageBytesHash(bytes)!==job.body_hash)throw new HttpError(400,'image_task_invalid_input');
  const request=new Request('https://image-worker.internal/v1/images/'+job.operation,{method:'POST',headers:{'content-type':job.content_type},body:bytes as BodyInit,signal});
  phase='start';
  const started=await jobRPC(db,'s2a_personal_image_job_start',{p_id:job.id,p_lease_id:job.lease_id});
  if(started.started!==true)throw new HttpError(503,'invalid_image_job_response');
  phase='inference';
  const output=await proxyImageJob(request,job,db,{requestId:crypto.randomUUID(),started:Date.now(),endpoint:'/v1/images/'+job.operation});
  if(!output.ok){await output.body?.cancel();return await finish(db,job,output.status>=400?output.status:502,'image_task_failed',null);}
  phase='storage';
  const hash=await storeImageResult(db,job,output,signal);
  return await finish(db,job,output.status,null,hash);
 }catch(error){
  // A missing result after dispatch is never grounds for another generation.
  if(job.recover||phase==='start'||phase==='storage'||phase==='input'&&!(error instanceof HttpError&&[400,404,413,502].includes(error.status))){console.warn('image_job_recovery_pending');return false;}
  try{
   const status=signal.aborted?504:error instanceof HttpError&&error.status>=400&&error.status<=599?error.status:502;
   return await finish(db,job,status,signal.aborted?'image_task_timeout':phase==='input'?'image_task_invalid_input':'image_task_failed',null);
  }catch{console.warn('image_job_completion_pending');return false;}
 }
}
export async function runImageJobs(db:Database):Promise<{claimed:number;finished:number}>{
 if(db.config.dataModel!=='native')throw new HttpError(501,'native_data_model_required');
 const jobs=await db.rpc<ImageJob[]>('s2a_personal_image_jobs_claim',{});
 if(!Array.isArray(jobs)||jobs.length>1)throw new HttpError(503,'invalid_image_jobs');
 for(const job of jobs)validateJob(job);
 let finished=0;for(const job of jobs)if(await executeImageJob(db,job))finished++;
 return {claimed:jobs.length,finished};
}
export async function cleanupImageJobs(db:Database):Promise<number>{
 const jobs=await db.rpc<{id:string;lease_id:string}[]>('s2a_personal_image_cleanup_claim',{});
 if(!Array.isArray(jobs)||jobs.length>2)throw new HttpError(503,'invalid_image_cleanup_jobs');
 let finished=0;
 for(const job of jobs){
  if(!job||!/^imgtask_[a-f0-9]{32}$/.test(job.id)||!/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(job.lease_id))throw new HttpError(503,'invalid_image_cleanup_jobs');
  try{
   const paths=await listTaskArtifacts(db,job.id);
   for(let offset=0;offset<paths.length;offset+=100)await deleteArtifacts(db,paths.slice(offset,offset+100));
   if((await listTaskArtifacts(db,job.id)).length)continue;
   if(await db.rpc<boolean>('s2a_personal_image_cleanup_finish',{p_id:job.id,p_lease_id:job.lease_id}))finished++;
  }catch{console.warn('image_cleanup_pending');}
 }
 return finished;
}
async function dispatchImages(db:Database):Promise<unknown>{
 return await Promise.all([runImageJobs(db),cleanupImageJobs(db)]);
}
export async function imageJobs(request:Request,db:Database):Promise<Response>{
 await authorizeJob(request,db,'images');
 if(db.config.dataModel!=='native')throw new HttpError(501,'native_data_model_required');
 const runtime=(globalThis as typeof globalThis&{EdgeRuntime?:{waitUntil(promise:Promise<unknown>):void}}).EdgeRuntime;
 if(runtime){runtime.waitUntil(dispatchImages(db).catch(()=>console.warn('image_job_dispatch_failed')));return json(202,{accepted:true});}
 const [work,cleaned]=await Promise.all([runImageJobs(db),cleanupImageJobs(db)]);return json(200,{...work,cleaned});
}
export function kickImageJobs(db:Database):void{
 const runtime=(globalThis as typeof globalThis&{EdgeRuntime?:{waitUntil(promise:Promise<unknown>):void}}).EdgeRuntime;
 if(runtime)runtime.waitUntil(runImageJobs(db).catch(()=>console.warn('image_job_dispatch_failed')));
}
