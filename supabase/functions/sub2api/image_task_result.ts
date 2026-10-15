import {Database,HttpError} from './db.ts';
import {getArtifact,imageArtifactPath,putArtifact,signArtifact} from './artifact_storage.ts';
import {imageBytesHash,type ImageTaskView} from './image_task_submit.ts';

type ImageEntry=Record<string,unknown>&{artifact_path?:string;artifact_hash?:string;url?:string};
export type ImageManifest={version:1;task_id:string;model:string;operation:string;http_status:number;result:Record<string,unknown>&{data:ImageEntry[]}};
export async function boundedImageBytes(response:Response,limit:number):Promise<Uint8Array>{
 const reader=response.body?.getReader();if(!reader)throw new HttpError(502,'invalid_image_task_result');
 const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>limit)throw new HttpError(502,'image_task_result_too_large');chunks.push(chunk.value);}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
function imageURL(value:unknown):boolean{
 if(typeof value!=='string'||value.length>16384)return false;
 try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password;}catch{return false;}
}
function extension(bytes:Uint8Array):'png'|'jpg'|'webp'|'gif'|'avif'{
 if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'jpg';
 const ascii=new TextDecoder().decode(bytes.subarray(0,16));
 if(ascii.startsWith('RIFF')&&ascii.slice(8,12)==='WEBP')return 'webp';
 if(ascii.startsWith('GIF87a')||ascii.startsWith('GIF89a'))return 'gif';
 if(ascii.slice(4,8)==='ftyp'&&['avif','avis'].includes(ascii.slice(8,12)))return 'avif';
 if(bytes[0]===137&&ascii.slice(1,4)==='PNG')return 'png';
 throw new HttpError(502,'invalid_image_task_result');
}
function validateManifest(value:unknown,id:string,model?:string,operation?:string):ImageManifest{
 const manifest=value as ImageManifest|null;
 if(!manifest||manifest.version!==1||manifest.task_id!==id||typeof manifest.model!=='string'||!['generations','edits'].includes(manifest.operation)||model!==undefined&&manifest.model!==model||operation!==undefined&&manifest.operation!==operation||!Number.isInteger(manifest.http_status)||manifest.http_status<200||manifest.http_status>=300||!manifest.result||typeof manifest.result!=='object'||Array.isArray(manifest.result)||!Array.isArray(manifest.result.data)||!manifest.result.data.length||manifest.result.data.length>100)throw new HttpError(502,'invalid_image_task_result');
 for(let index=0;index<manifest.result.data.length;index++){
  const entry=manifest.result.data[index];
  if(!entry||typeof entry!=='object'||Array.isArray(entry)||'b64_json' in entry)throw new HttpError(502,'invalid_image_task_result');
  if(entry.artifact_path!==undefined){
   if(typeof entry.artifact_path!=='string'||!['png','jpg','webp','gif','avif'].some(ext=>entry.artifact_path===imageArtifactPath(id,index+1,ext))||typeof entry.artifact_hash!=='string'||!/^[a-f0-9]{64}$/.test(entry.artifact_hash)||entry.url!==undefined)throw new HttpError(502,'invalid_image_task_result');
  }else if(!imageURL(entry.url)||entry.artifact_hash!==undefined)throw new HttpError(502,'invalid_image_task_result');
 }
 return manifest;
}
export async function storeImageResult(db:Database,task:{id:string;model:string;operation:string},response:Response,signal:AbortSignal):Promise<string>{
 if(!response.ok)throw new HttpError(502,'invalid_image_task_result');
 const bytes=await boundedImageBytes(response,256*1024*1024);
 let result:Record<string,unknown>&{data:ImageEntry[]};
 try{result=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new HttpError(502,'invalid_image_task_result');}
 if(!result||typeof result!=='object'||Array.isArray(result)||!Array.isArray(result.data)||!result.data.length||result.data.length>100)throw new HttpError(502,'invalid_image_task_result');
 for(let index=0;index<result.data.length;index++){
  const entry=result.data[index];
  if(!entry||typeof entry!=='object'||Array.isArray(entry)||'artifact_path' in entry||'artifact_hash' in entry)throw new HttpError(502,'invalid_image_task_result');
  const inline=typeof entry.url==='string'?/^data:image\/(?:png|jpeg|jpg|webp|gif|avif);base64,([A-Za-z0-9+/]*={0,2})$/.exec(entry.url):null;
  if(entry.b64_json!==undefined||inline){
   const encodedImage=entry.b64_json??inline?.[1];
   if(typeof encodedImage!=='string'||!encodedImage.length||encodedImage.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(encodedImage))throw new HttpError(502,'invalid_image_task_result');
   let image:Uint8Array;try{image=Uint8Array.from(atob(encodedImage),char=>char.charCodeAt(0));}catch{throw new HttpError(502,'invalid_image_task_result');}
   const ext=extension(image),path=imageArtifactPath(task.id,index+1,ext);
   await putArtifact(db,path,image,'image/'+(ext==='jpg'?'jpeg':ext),signal);
   delete entry.b64_json;delete entry.url;entry.artifact_path=path;entry.artifact_hash=await imageBytesHash(image);
  }
 }
 const manifest:ImageManifest={version:1,task_id:task.id,model:task.model,operation:task.operation,http_status:response.status,result};
 validateManifest(manifest,task.id,task.model,task.operation);
 const encoded=new TextEncoder().encode(JSON.stringify(manifest));
 if(encoded.length>1024*1024)throw new HttpError(502,'image_task_result_too_large');
 await putArtifact(db,imageArtifactPath(task.id,'result','json'),encoded,'application/json',signal);
 return imageBytesHash(encoded);
}
export async function loadImageManifest(db:Database,id:string,signal:AbortSignal,expected?:{hash?:string;model?:string;operation?:string}):Promise<{manifest:ImageManifest;hash:string}>{
 const response=await getArtifact(db,imageArtifactPath(id,'result','json'),signal),bytes=await boundedImageBytes(response,1024*1024),hash=await imageBytesHash(bytes);
 if(expected?.hash!==undefined&&hash!==expected.hash)throw new HttpError(502,'invalid_image_task_result');
 let value:unknown;try{value=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new HttpError(502,'invalid_image_task_result');}
 return {manifest:validateManifest(value,id,expected?.model,expected?.operation),hash};
}
export async function renderImageTask(db:Database,task:ImageTaskView,signal:AbortSignal):Promise<Record<string,unknown>>{
 const {result_path:_path,result_hash:hash,...view}=task;
 if(task.status!=='completed')return view;
 if(task.result_path!==imageArtifactPath(task.id,'result','json')||!hash||!/^[a-f0-9]{64}$/.test(hash))throw new HttpError(502,'invalid_image_task_result');
 const {manifest}=await loadImageManifest(db,task.id,signal,{hash});
 const data=await Promise.all(manifest.result.data.map(async entry=>{
  const {artifact_path:path,artifact_hash:_hash,...value}=entry;
  return path?{...value,url:await signArtifact(db,path)}:value;
 }));
 const result={...manifest.result,data};return {...view,result,image_url:data[0]?.url};
}
