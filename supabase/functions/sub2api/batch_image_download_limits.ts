import {HttpError} from './db.ts';
export const BATCH_ZIP_MAX_BYTES=512*1024*1024;
export const BATCH_DOWNLOAD_MAX_MS=10*60*1000;
export function limitedBatchDownload(source:ReadableStream<Uint8Array>,signal:AbortSignal,maxBytes=BATCH_ZIP_MAX_BYTES):ReadableStream<Uint8Array>{
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>BATCH_ZIP_MAX_BYTES)throw new HttpError(500,'invalid_batch_download_limit');
 const reader=source.getReader();let bytes=0,closed=false;
 const release=()=>{if(!closed){closed=true;reader.releaseLock();}};
 return new ReadableStream({
  async pull(controller){
   try{
    signal.throwIfAborted();const chunk=await reader.read();signal.throwIfAborted();
    if(chunk.done){release();controller.close();return;}
    bytes+=chunk.value.length;if(bytes>maxBytes)throw new HttpError(413,'batch_image_download_too_large');
    controller.enqueue(chunk.value);
   }catch(error){controller.error(error);await reader.cancel().catch(()=>{});release();}
  },
  async cancel(reason){try{await reader.cancel(reason);}finally{release();}},
 });
}
