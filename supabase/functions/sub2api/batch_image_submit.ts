import {Database,HttpError} from './db.ts';
import {batchImageInput} from './batch_image_input.ts';
import {imageBytesHash} from './image_task_submit.ts';
import {storeBatchRequest} from './batch_image_storage.ts';
function checked(value:unknown,id:string):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(503,'invalid_batch_submission_response');
 const row=value as Record<string,unknown>;
 if(typeof row.error==='string')throw new HttpError(typeof row.status==='number'?row.status:503,row.error);
 if(row.id!==id||typeof row.ready!=='boolean')throw new HttpError(503,'invalid_batch_submission_response');return row;
}
// Restore the stored automatic name before hashing a retry of the same batch.
export async function submitBatchImage(db:Database,keyHash:string,input:unknown,options:{id?:string;clientIP?:string|null;signal?:AbortSignal}={}):Promise<{id:string;ready:true}>{
 if(db.config.dataModel!=='native')throw new HttpError(501,'native_data_model_required');
 const id=options.id??'imgbatch_'+crypto.randomUUID().replaceAll('-',''),signal=options.signal??AbortSignal.timeout(60000);
 if(!/^imgbatch_[a-f0-9]{32}$/.test(id)||!/^[a-f0-9]{64}$/.test(keyHash))throw new HttpError(400,'invalid_batch_submission');
 let normalized=batchImageInput(input);
 const raw=input as Record<string,unknown>;
 const automaticName=Boolean(options.id&&(raw.task_name===undefined||raw.task_name===null||typeof raw.task_name==='string'&&!raw.task_name.trim()));
 async function restoreName(){
  const existing=await db.rpc<Record<string,unknown>>('s2a_batch_image_read',{p_key_hash:keyHash,p_id:id,p_client_ip:options.clientIP??null});
  if(!existing||typeof existing!=='object'||Array.isArray(existing))throw new HttpError(503,'invalid_batch_submission_response');
  if(typeof existing.error==='string'){
   if(existing.error!=='batch_image_not_found'||existing.status!==404)throw new HttpError(typeof existing.status==='number'?existing.status:503,existing.error);
  }else{
   if(existing.id!==id||typeof existing.task_name!=='string')throw new HttpError(503,'invalid_batch_submission_response');
   normalized=batchImageInput({...raw,task_name:existing.task_name});
  }
 }
 if(automaticName)await restoreName();
 let hash=await imageBytesHash(new TextEncoder().encode(JSON.stringify(normalized)));
 const prepare=async()=>checked(await db.rpc('s2a_batch_image_prepare',{p_key_hash:keyHash,p_id:id,p_hash:hash,p_model:normalized.model,p_provider:normalized.provider,p_parent:normalized.parent_batch_id||null,p_vertex_enabled:Boolean(db.config.vertexBatch?.bucket),p_count:normalized.items.length,p_name:normalized.task_name,p_client_ip:options.clientIP??null}),id);
 let prepared:Record<string,unknown>;
 try{prepared=await prepare();}
 catch(error){
  if(!automaticName||!(error instanceof HttpError)||error.status!==409||error.code!=='batch_image_conflict')throw error;
  // A concurrent first submission may persist its generated name after our initial read.
  await restoreName();hash=await imageBytesHash(new TextEncoder().encode(JSON.stringify(normalized)));
  prepared=await prepare();
 }

 if(prepared.ready===true)return {id,ready:true};
 const stored=await storeBatchRequest(db,id,normalized,signal);
 if(stored.requestHash!==hash)throw new HttpError(503,'batch_submission_hash_changed');
 const ready=checked(await db.rpc('s2a_batch_image_ready',{p_key_hash:keyHash,p_id:id,p_hash:hash,p_client_ip:options.clientIP??null}),id);
 if(ready.ready!==true)throw new HttpError(503,'batch_submission_not_ready');
 return {id,ready:true};
}
