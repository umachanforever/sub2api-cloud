import {Database,HttpError} from './db.ts';
import type {Account} from './accounts.ts';
import type {ApiKeyCredentials} from './gateway.ts';
import {GeminiBatchClient,buildGeminiBatchJSONL} from './gemini_batch.ts';
import {vertexBatchProvider} from './vertex_batch_provider.ts';
import {executeBatchImageJob} from './batch_image_execute.ts';
import type {BatchExecutionJob,BatchExecutionProvider} from './batch_image_execute.ts';
import {loadBatchRequest,loadBatchCreated,storeBatchCreated} from './batch_image_storage.ts';

type Admission={account:Account&{credential_storage:'vault';type:string;credentials:Record<string,unknown>};provider:'gemini_api'|'vertex';model:string;request_hash:string};
export type BatchRunnerOptions={vertex?:{bucket:string;location?:string;environment?:string};index:(job:BatchExecutionJob,admission:Admission,signal:AbortSignal)=>Promise<boolean>};
function checked(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(503,'invalid_batch_runtime_response');
 const row=value as Record<string,unknown>;if(typeof row.error==='string')throw new HttpError(typeof row.status==='number'?row.status:503,row.error);return row;
}
export async function runBatchImageJobs(db:Database,options:BatchRunnerOptions):Promise<{claimed:number;processed:number}>{
 if(db.config.dataModel!=='native')throw new HttpError(501,'native_data_model_required');
 const jobs=await db.rpc<BatchExecutionJob[]>('s2a_batch_image_runtime_claim',{});
 if(!Array.isArray(jobs)||jobs.length>1)throw new HttpError(503,'invalid_batch_runtime_jobs');
 let processed=0;
 for(const job of jobs){
  if(!job||!/^imgbatch_[a-f0-9]{32}$/.test(job.batch_id)||! /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(job.lease_id))throw new HttpError(503,'invalid_batch_runtime_job');
  let admission:Admission;
  try{
   admission=checked(await db.rpc('s2a_batch_image_runtime_admit',{p_id:job.batch_id,p_lease:job.lease_id})) as unknown as Admission;
  }catch(error){
   if(error instanceof HttpError&&[401,403,409].includes(error.status)&&error.code!=='batch_image_lease_lost'){
    checked(await db.rpc('s2a_batch_image_runtime_fail',{p_id:job.batch_id,p_lease:job.lease_id,p_error:'BATCH_ADMISSION_REVOKED'}));processed++;
   }
   continue;
  }
  if(!['gemini_api','vertex'].includes(admission.provider)||!admission.account||admission.account.platform!=='gemini'||admission.account.credential_storage!=='vault'||typeof admission.account.id!=='string'||!admission.account.credentials||typeof admission.model!=='string'||!/^[a-f0-9]{64}$/.test(admission.request_hash))throw new HttpError(503,'invalid_batch_runtime_admission');
  const binding={batchID:job.batch_id,requestHash:admission.request_hash,provider:admission.provider};
  let provider:BatchExecutionProvider;
  if(admission.provider==='vertex'){
   if(!options.vertex?.bucket)throw new HttpError(503,'vertex_managed_bucket_required');
   provider=vertexBatchProvider(db,admission.account,admission.account.credentials,{...options.vertex,batchID:job.batch_id});
  }else{
   const client=new GeminiBatchClient(db,admission.account,admission.account.credentials as ApiKeyCredentials);
   provider={
    uploadInput:async(input,signal)=>({input_ref:await client.uploadJSONL(buildGeminiBatchJSONL(input),job.batch_id,signal),output_ref:'gemini:pending'}),
    createUploadedBatch:(model,name,checkpoint,signal)=>client.createBatch(model,checkpoint.input_ref,name,signal),
    getBatch:(name,signal)=>client.getBatch(name,signal),
   };
  }
  if(await executeBatchImageJob(db,job,{
   provider,
   loadInput:async(signal)=>{
    const input=await loadBatchRequest(db,binding,signal);
    if(input.model!==admission.model)throw new HttpError(409,'batch_model_binding_mismatch');return input;
   },
   saveCreated:(name,signal)=>storeBatchCreated(db,binding,name,signal),
   loadCreated:(signal)=>loadBatchCreated(db,binding,signal),
   index:(signal)=>options.index(job,admission,signal),
  }))processed++;
 }
 return {claimed:jobs.length,processed};
}
