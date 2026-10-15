import {Database,HttpError} from './db.ts';
import type {GeminiBatchInput,GeminiBatchStatus} from './gemini_batch.ts';
export type BatchExecutionJob={batch_id:string;lease_id:string;stage:'upload'|'create'|'poll'|'index';recover_create:boolean;cancel_requested?:boolean;input_ref?:string|null;output_ref?:string|null;provider_job_name?:string|null};
export type BatchExecutionProvider={
 uploadInput(input:GeminiBatchInput,signal:AbortSignal):Promise<{input_ref:string;output_ref:string}>;
 createUploadedBatch(model:string,displayName:string,checkpoint:{input_ref:string;output_ref:string},signal:AbortSignal):Promise<GeminiBatchStatus>;
 getBatch(name:string,signal:AbortSignal):Promise<GeminiBatchStatus>;
 cancelBatch?(name:string,signal:AbortSignal):Promise<void>;
};
export type BatchExecutionDependencies={
 provider:BatchExecutionProvider;
 loadInput(signal:AbortSignal):Promise<GeminiBatchInput&{task_name?:string}>;
 saveCreated(name:string,signal:AbortSignal):Promise<void>;
 loadCreated(signal:AbortSignal):Promise<string|null>;
 index(signal:AbortSignal):Promise<boolean>;
};
async function rpc(db:Database,name:string,job:BatchExecutionJob,args:Record<string,unknown>={}):Promise<Record<string,unknown>>{
 const value=await db.rpc<Record<string,unknown>>(name,{p_id:job.batch_id,p_lease:job.lease_id,...args});
 if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(503,'invalid_batch_runtime_response');
 if(typeof value.error==='string')throw new HttpError(typeof value.status==='number'?value.status:503,value.error);
 return value;
}
export async function executeBatchImageJob(db:Database,job:BatchExecutionJob,deps:BatchExecutionDependencies):Promise<boolean>{
 if(!job||!/^imgbatch_[A-Za-z0-9_-]{1,55}$/.test(job.batch_id)||! /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(job.lease_id)||!['upload','create','poll','index'].includes(job.stage)||typeof job.recover_create!=='boolean')throw new HttpError(503,'invalid_batch_runtime_job');
 const signal=AbortSignal.timeout(125000);
 try{
  if(job.stage==='index')return await deps.index(signal);
  if(job.stage==='poll'){
   if(!job.provider_job_name)throw new HttpError(503,'invalid_batch_runtime_job');
   if(job.cancel_requested){
    if(!deps.provider.cancelBatch)throw new HttpError(503,'batch_cancellation_unavailable');
    // Cancellation can already have completed upstream; always poll its authoritative state.
    try{await deps.provider.cancelBatch(job.provider_job_name,signal);}catch{console.warn('batch_image_cancel_pending');}
   }
   const observed=await deps.provider.getBatch(job.provider_job_name,signal);
   await rpc(db,'s2a_batch_image_runtime_observed',job,{p_state:observed.status,p_output:observed.output_ref??null,p_error:observed.error_code??null});return true;
  }
  // A lost creation response is recovered only from a saved receipt, never by a second POST.
  if(job.recover_create){
   const name=await deps.loadCreated(signal);
   if(name)await rpc(db,'s2a_batch_image_runtime_created',job,{p_name:name});
   else await rpc(db,'s2a_batch_image_runtime_fail',job,{p_error:'BATCH_CREATE_RESULT_UNKNOWN'});
   return true;
  }
  const input=await deps.loadInput(signal);
  let checkpoint:{input_ref:string;output_ref:string};
  if(job.stage==='upload'){
   checkpoint=await deps.provider.uploadInput(input,signal);
   await rpc(db,'s2a_batch_image_runtime_checkpoint',job,{p_input:checkpoint.input_ref,p_output:checkpoint.output_ref});
  }else{
   if(!job.input_ref||!job.output_ref)throw new HttpError(503,'invalid_batch_runtime_checkpoint');
   checkpoint={input_ref:job.input_ref,output_ref:job.output_ref};
  }
  // Do not retry dispatch RPCs: an acknowledgement loss must become recovery.
  const dispatched=await rpc(db,'s2a_batch_image_runtime_dispatch',job);
  if(dispatched.dispatched!==true)throw new HttpError(503,'invalid_batch_runtime_dispatch');
  const created=await deps.provider.createUploadedBatch(input.model,input.task_name??job.batch_id,checkpoint,signal);
  await deps.saveCreated(created.name,signal);
  await rpc(db,'s2a_batch_image_runtime_created',job,{p_name:created.name});return true;
 }catch(error){
  // Malformed immutable provider output cannot become valid on a later poll.
  if(job.stage==='index'&&error instanceof HttpError&&[
   'batch_image_index_parse_failed','batch_image_duplicate_custom_id','batch_image_result_line_too_large',
  ].includes(error.code)){
   try{await rpc(db,'s2a_batch_image_runtime_fail',job,{p_error:'BATCH_RESULT_INVALID'});return true;}
   catch{console.warn('batch_image_failure_checkpoint_pending');return false;}
  }
  // Leave the lease to expire. The next claim determines whether POST creation was dispatched.
  console.warn('batch_image_execution_pending');return false;
 }
}
