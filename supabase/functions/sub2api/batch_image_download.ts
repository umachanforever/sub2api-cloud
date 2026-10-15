import {Database,HttpError} from './db.ts';
import {batchImageContent} from './batch_image_content.ts';
import {zipStream} from './zip_stream.ts';
import type {ZipEntry} from './zip_stream.ts';
export async function downloadBatchImages(db:Database,keyHash:string,batchID:string,clientIP:string|null=null):Promise<Response>{
 if(!/^imgbatch_[a-f0-9]{32}$/.test(batchID))throw new HttpError(400,'invalid_batch_id');
 const snapshot=await db.rpc<Record<string,unknown>>('s2a_batch_image_read',{p_key_hash:keyHash,p_id:batchID,p_client_ip:clientIP});
 if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))throw new HttpError(503,'invalid_batch_download');
 if(typeof snapshot.error==='string')throw new HttpError(typeof snapshot.status==='number'?snapshot.status:503,snapshot.error);
 if(snapshot.id!==batchID||!Array.isArray(snapshot.items)||snapshot.items.length>200)throw new HttpError(503,'invalid_batch_download');
 if(snapshot.output_deletion_pending===true)throw new HttpError(410,'batch_image_output_expired');
 if(snapshot.status!=='completed')throw new HttpError(409,'batch_image_not_completed');
 if(typeof snapshot.output_expires_at==='string'&&(!Number.isFinite(Date.parse(snapshot.output_expires_at))||Date.parse(snapshot.output_expires_at)<=Date.now()))throw new HttpError(410,'batch_image_output_expired');
 const items=snapshot.items as Record<string,unknown>[];
 for(const item of items)if(!item||typeof item.custom_id!=='string'||!['success','failed','cancelled'].includes(String(item.status))||!Number.isSafeInteger(item.image_count)||(item.image_count as number)<0)throw new HttpError(503,'invalid_batch_download');
 const files:Record<string,unknown>[]=[],errors:Record<string,unknown>[]=[];
 async function* entries():AsyncGenerator<ZipEntry>{
  for(let ordinal=0;ordinal<items.length;ordinal++){
   const item=items[ordinal];
   if(item.status!=='success'){errors.push({custom_id:item.custom_id,error_code:typeof item.error_code==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test(item.error_code)?item.error_code:'PROVIDER_ITEM_FAILED'});continue;}
   for(let index=0;index<(item.image_count as number);index++){
    const response=await batchImageContent(db,keyHash,batchID,item.custom_id as string,index,clientIP);
    const mime=response.headers.get('content-type'),extension=mime==='image/png'?'png':['image/jpeg','image/jpg'].includes(mime??'')?'jpg':mime==='image/webp'?'webp':'bin';
    const name=`images/item-${String(ordinal+1).padStart(6,'0')}-${index+1}.${extension}`;
    files.push({custom_id:item.custom_id,image_index:index,filename:name,mime_type:mime});yield {name,bytes:new Uint8Array(await response.arrayBuffer())};
   }
  }
  yield {name:'manifest.json',bytes:new TextEncoder().encode(JSON.stringify({batch_id:batchID,model:snapshot.model,item_count:snapshot.item_count,success_count:snapshot.success_count,fail_count:snapshot.fail_count,files}))};
  yield {name:'errors.json',bytes:new TextEncoder().encode(JSON.stringify(errors))};
 }
 return new Response(zipStream(entries()),{headers:{'content-type':'application/zip','content-disposition':`attachment; filename="${batchID}.zip"`,'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
}
