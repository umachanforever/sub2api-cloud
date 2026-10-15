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
// Retrying a caller-supplied ID requires the same normalized request, including task_name.
export async function submitBatchImage(db:Database,keyHash:string,input:unknown,options:{id?:string;clientIP?:string|null;signal?:AbortSignal}={}):Promise<{id:string;ready:true}>{
 if(db.config.dataModel!=='native')throw new HttpError(501,'native_data_model_required');
 const normalized=batchImageInput(input),id=options.id??'imgbatch_'+crypto.randomUUID().replaceAll('-',''),signal=options.signal??AbortSignal.timeout(60000);
 if(!/^imgbatch_[a-f0-9]{32}$/.test(id)||!/^[a-f0-9]{64}$/.test(keyHash))throw new HttpError(400,'invalid_batch_submission');
 const body=new TextEncoder().encode(JSON.stringify(normalized)),hash=await imageBytesHash(body);
 const prepared=checked(await db.rpc('s2a_batch_image_prepare',{p_key_hash:keyHash,p_id:id,p_hash:hash,p_model:normalized.model,p_provider:normalized.provider||'gemini_api',p_count:normalized.items.length,p_name:normalized.task_name,p_client_ip:options.clientIP??null}),id);
 if(prepared.ready===true)return {id,ready:true};
 const stored=await storeBatchRequest(db,id,normalized,signal);
 if(stored.requestHash!==hash)throw new HttpError(503,'batch_submission_hash_changed');
 const ready=checked(await db.rpc('s2a_batch_image_ready',{p_key_hash:keyHash,p_id:id,p_hash:hash,p_client_ip:options.clientIP??null}),id);
 if(ready.ready!==true)throw new HttpError(503,'batch_submission_not_ready');
 return {id,ready:true};
}
