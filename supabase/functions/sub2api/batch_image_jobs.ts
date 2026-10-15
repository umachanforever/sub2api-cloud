import {Database,HttpError} from './db.ts';
import {authorizeJob} from './privacy_jobs.ts';
import {runBatchImageJobs,type BatchRunnerOptions} from './batch_image_runner.ts';
import {cleanupBatchImages} from './batch_image_cleanup.ts';
import {batchProviderCleanup} from './batch_image_provider_cleanup.ts';
import {json} from './http.ts';
export async function batchImageJobs(request:Request,db:Database,options:BatchRunnerOptions={vertex:db.config.vertexBatch}):Promise<Response>{
 await authorizeJob(request,db,'batch-images');
 if(db.config.dataModel!=='native')throw new HttpError(501,'native_data_model_required');
 const dispatch=async()=>{
  const [work,cleaned]=await Promise.all([runBatchImageJobs(db,options),cleanupBatchImages(db,batchProviderCleanup(db,options))]);
  return {...work,cleaned};
 };
 const runtime=(globalThis as typeof globalThis&{EdgeRuntime?:{waitUntil(promise:Promise<unknown>):void}}).EdgeRuntime;
 if(runtime){runtime.waitUntil(dispatch().catch(()=>console.warn('batch_image_dispatch_failed')));return json(202,{accepted:true});}
 return json(200,await dispatch());
}

export function kickBatchImageJobs(db:Database):void{
 const runtime=(globalThis as typeof globalThis&{EdgeRuntime?:{waitUntil(promise:Promise<unknown>):void}}).EdgeRuntime;
 if(runtime)runtime.waitUntil(Promise.all([
  runBatchImageJobs(db,{vertex:db.config.vertexBatch}),
  cleanupBatchImages(db,batchProviderCleanup(db,{vertex:db.config.vertexBatch})),
 ]).catch(()=>console.warn('batch_image_dispatch_failed')));
}
