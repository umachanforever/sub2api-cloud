import {Database,HttpError} from './db.ts';
import {getArtifact} from './artifact_storage.ts';
export async function batchImageContent(db:Database,keyHash:string,batchID:string,customID:string,imageIndex=0,clientIP:string|null=null,signal:AbortSignal=AbortSignal.timeout(30000)):Promise<Response>{
 if(!/^imgbatch_[a-f0-9]{32}$/.test(batchID)||!Number.isSafeInteger(imageIndex)||imageIndex<0)throw new HttpError(400,'invalid_batch_image_content');
 const resolved=await db.rpc<Record<string,unknown>>('s2a_batch_image_content_resolve',{p_key_hash:keyHash,p_id:batchID,p_custom_id:customID,p_client_ip:clientIP});
 if(!resolved||typeof resolved!=='object'||Array.isArray(resolved))throw new HttpError(503,'invalid_batch_image_content');
 if(typeof resolved.error==='string')throw new HttpError(typeof resolved.status==='number'?resolved.status:503,resolved.error);
 if(resolved.custom_id!==customID||typeof resolved.path!=='string'||!new RegExp('^batches/'+batchID+'/item-([1-9]|[1-9][0-9]|1[0-9]{2}|200)[.]json$').test(resolved.path)||!Number.isSafeInteger(resolved.image_count)||(resolved.image_count as number)<1)throw new HttpError(503,'invalid_batch_image_content');
 if(imageIndex>=(resolved.image_count as number))throw new HttpError(400,'batch_image_index_out_of_range');
 const response=await getArtifact(db,resolved.path,signal),reader=response.body?.getReader();if(!reader)throw new HttpError(502,'invalid_batch_image_artifact');
 let value:any;
 try{
  const chunks:Uint8Array[]=[];let size=0;
  for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>16*1024*1024)throw Error('limit');chunks.push(part.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
  value=JSON.parse(new TextDecoder().decode(bytes));
 }catch{throw new HttpError(502,'invalid_batch_image_artifact');}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 if(value?.custom_id!==customID||!Array.isArray(value.images)||value.images.length!==resolved.image_count)throw new HttpError(502,'invalid_batch_image_artifact');
 const image=value.images[imageIndex];
 if(typeof image?.mime_type!=='string'||!/^image\/[A-Za-z0-9.+_-]{1,100}$/.test(image.mime_type)||typeof image.data!=='string'||!image.data||image.data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data))throw new HttpError(502,'invalid_batch_image_artifact');
 let decoded:Uint8Array<ArrayBuffer>;try{decoded=Uint8Array.from(atob(image.data),character=>character.charCodeAt(0));}catch{throw new HttpError(502,'invalid_batch_image_artifact');}
 const extension=['png','jpg','webp'].includes(image.extension)?image.extension:'bin';
 return new Response(decoded,{headers:{'content-type':image.mime_type,'content-length':String(decoded.length),'content-disposition':`attachment; filename="image-${imageIndex+1}.${extension}"`,'cache-control':'private, max-age=300','x-content-type-options':'nosniff'}});
}
