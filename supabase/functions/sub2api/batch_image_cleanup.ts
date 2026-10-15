import {Database,HttpError} from './db.ts';
import {listBatchArtifacts,deleteArtifacts} from './artifact_storage.ts';
export type BatchCleanupJob={batch_id:string;cleanup_lease:string;provider:'gemini_api'|'vertex';account_id:number|string;input_ref:string|null;output_ref:string|null};
export async function cleanupBatchImages(db:Database,cleanupProvider:(job:BatchCleanupJob,signal:AbortSignal)=>Promise<void>):Promise<number>{
 const jobs=await db.rpc<BatchCleanupJob[]>('s2a_batch_image_cleanup_claim',{});
 if(!Array.isArray(jobs)||jobs.length>1)throw new HttpError(503,'invalid_batch_cleanup_jobs');
 let finished=0;
 for(const job of jobs){
  if(!job||!/^imgbatch_[a-f0-9]{32}$/.test(job.batch_id)||! /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(job.cleanup_lease)||!['gemini_api','vertex'].includes(job.provider))throw new HttpError(503,'invalid_batch_cleanup_jobs');
  try{
   await cleanupProvider(job,AbortSignal.timeout(125000));
   const paths=await listBatchArtifacts(db,job.batch_id);
   for(let offset=0;offset<paths.length;offset+=100)await deleteArtifacts(db,paths.slice(offset,offset+100));
   if((await listBatchArtifacts(db,job.batch_id)).length)throw new HttpError(503,'batch_cleanup_incomplete');
   const result=await db.rpc<Record<string,unknown>>('s2a_batch_image_cleanup_finish',{p_id:job.batch_id,p_lease:job.cleanup_lease});
   if(result?.applied!==true)throw new HttpError(503,'batch_cleanup_completion_pending');finished++;
  }catch{console.warn('batch_image_cleanup_pending');}
 }
 return finished;
}
