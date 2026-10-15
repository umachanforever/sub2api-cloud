import {Database,HttpError} from './db.ts';
import {BATCH_DOWNLOAD_MAX_MS} from './batch_image_download_limits.ts';
export async function withBatchDownloadPermit(db:Database,keyHash:string,batchID:string,clientIP:string|null,requestSignal:AbortSignal,create:(signal:AbortSignal)=>Promise<Response>):Promise<Response>{
 const permit=await db.rpc<{lease_id?:string;error?:string;status?:number}>('s2a_batch_image_download_acquire',{p_key_hash:keyHash,p_id:batchID,p_client_ip:clientIP});
 if(permit?.error)throw new HttpError(permit.status??503,permit.error);
 if(typeof permit?.lease_id!=='string'||!/^[a-f0-9-]{36}$/.test(permit.lease_id))throw new HttpError(503,'invalid_batch_download_permit');
 let released=false,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 const release=async()=>{
  if(released)return;released=true;
  try{await db.rpc('s2a_batch_image_download_release',{p_lease:permit.lease_id});}catch{console.warn('batch_image_download_release_failed');}
 };
 const signal=AbortSignal.any([requestSignal,AbortSignal.timeout(BATCH_DOWNLOAD_MAX_MS)]);
 const abort=()=>{void (async()=>{try{await reader?.cancel(signal.reason);}catch{}finally{await release();}})();};
 signal.addEventListener('abort',abort,{once:true});
 const finish=async()=>{signal.removeEventListener('abort',abort);await release();};
 try{
  signal.throwIfAborted();const response=await create(signal);signal.throwIfAborted();
  if(!response.body){await finish();return response;}
  reader=response.body.getReader();
  return new Response(new ReadableStream<Uint8Array>({
   async pull(controller){try{signal.throwIfAborted();const chunk=await reader!.read();signal.throwIfAborted();if(chunk.done){await finish();controller.close();}else controller.enqueue(chunk.value);}catch(error){try{await reader!.cancel(error);}catch{}finally{await finish();controller.error(error);}}},
   async cancel(reason){try{await reader!.cancel(reason);}finally{await finish();}},
  },{highWaterMark:0}),{status:response.status,statusText:response.statusText,headers:response.headers});
 }catch(error){await finish();throw error;}
}
