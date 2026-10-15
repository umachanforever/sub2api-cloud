import type {Database} from './db.ts';
// Mark only a fully consumed stream; cancellation or media failures leave the state unchanged.
export function trackBatchDownload(response:Response,db:Database,keyHash:string,batchID:string,clientIP:string|null):Response{
 if(!response.body)return response;
 const reader=response.body.getReader();let closed=false;
 const body=new ReadableStream<Uint8Array>({
  async pull(controller){
   try{
    const chunk=await reader.read();
    if(!chunk.done){controller.enqueue(chunk.value);return;}
    closed=true;reader.releaseLock();
    try{
     const result=await db.rpc<{applied?:boolean}>('s2a_batch_image_mark_downloaded',{p_key_hash:keyHash,p_id:batchID,p_client_ip:clientIP});
     if(result?.applied!==true)console.warn('batch_image_download_checkpoint_failed');
    }catch{console.warn('batch_image_download_checkpoint_failed');}
    controller.close();
   }catch(error){controller.error(error);if(!closed){closed=true;await reader.cancel().catch(()=>{});reader.releaseLock();}}
  },
  async cancel(reason){if(!closed){closed=true;await reader.cancel(reason);reader.releaseLock();}},
 });
 return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
}
