import {Database,HttpError} from './db.ts';
const bucket='sub2api-artifacts';
const maxBytes=256*1024*1024;
export function imageArtifactPath(taskId:string,name:'request'|'result'|number,extension='bin'):string{
 if(typeof name!=='number'&&!['request','result'].includes(name))throw new HttpError(400,'invalid_artifact_path');
 if(!/^imgtask_[a-f0-9]{32}$/.test(taskId)||!['bin','json','png','jpg','webp','gif','avif'].includes(extension)||typeof name==='number'&&(!Number.isSafeInteger(name)||name<1||name>100))throw new HttpError(400,'invalid_artifact_path');
 return `images/${taskId}/${typeof name==='number'?'image-'+name:name}.${extension}`;
}
function encodedPath(path:string):string{
 if(/^batches\/imgbatch_[a-f0-9]{32}\/(?:request|created)\.json$/.test(path))return path.split('/').map(encodeURIComponent).join('/');
 if(!/^images\/imgtask_[a-f0-9]{32}\/(?:request|result|image-[1-9][0-9]?)\.(?:bin|json|png|jpg|webp|gif|avif)$/.test(path)&&!/^images\/imgtask_[a-f0-9]{32}\/image-100\.(?:bin|json|png|jpg|webp|gif|avif)$/.test(path))throw new HttpError(400,'invalid_artifact_path');
 return path.split('/').map(encodeURIComponent).join('/');
}
function storageURL(db:Database,path:string):string{return db.config.url+'/storage/v1/'+path;}
function auth(db:Database):Headers{return new Headers({authorization:'Bearer '+db.config.serviceKey,apikey:db.config.serviceKey});}
async function storageMetadata(response:Response,maxBytes=16384):Promise<any>{
 if(!response.body)throw new HttpError(502,'invalid_artifact_response');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>maxBytes)throw new HttpError(502,'invalid_artifact_response');chunks.push(part.value);}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new HttpError(502,'invalid_artifact_response');}
}
export async function putArtifact(db:Database,path:string,bytes:Uint8Array,contentType:string,signal?:AbortSignal):Promise<void>{
 const encoded=encodedPath(path);
 if(!(bytes instanceof Uint8Array))throw new HttpError(400,'invalid_artifact_size');
 if(!bytes.length||bytes.length>maxBytes)throw new HttpError(bytes.length?413:400,'invalid_artifact_size');
 if(!contentType||contentType.length>512||/[\r\n\x00]/.test(contentType))throw new HttpError(400,'invalid_artifact_content_type');
 const headers=auth(db);headers.set('content-type',contentType);headers.set('x-upsert','true');headers.set('cache-control','private, max-age=0');
 const response=await db.fetchImpl(storageURL(db,'object/'+bucket+'/'+encoded),{method:'POST',headers,body:bytes as BodyInit,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000),redirect:'error'});
 await response.body?.cancel();if(!response.ok)throw new HttpError(response.status===413?413:503,response.status===413?'artifact_too_large':'artifact_storage_unavailable');
}
export async function getArtifact(db:Database,path:string,signal:AbortSignal):Promise<Response>{
 const response=await db.fetchImpl(storageURL(db,'object/authenticated/'+bucket+'/'+encodedPath(path)),{headers:auth(db),signal,redirect:'error'});
 if(!response.ok){
  let missing=response.status===404;
  if(response.status===400){try{const error=await storageMetadata(response);missing=String(error?.statusCode)==='404'&&error?.error==='not_found';}catch{}}
  else await response.body?.cancel();
  throw new HttpError(missing?404:503,missing?'artifact_not_found':'artifact_storage_unavailable');
 }
 const length=response.headers.get('content-length');
 if(length&&/^\d+$/.test(length)&&Number(length)>maxBytes){await response.body?.cancel();throw new HttpError(502,'artifact_too_large');}
 if(!response.body)throw new HttpError(502,'invalid_artifact_response');
 let size=0;
 const bounded=response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){size+=chunk.length;if(size>maxBytes)throw new HttpError(502,'artifact_too_large');controller.enqueue(chunk);}}));
 return new Response(bounded,{headers:response.headers,status:response.status});
}
export async function signArtifact(db:Database,path:string,seconds=600):Promise<string>{
 const encoded=encodedPath(path);
 if(!Number.isSafeInteger(seconds)||seconds<1||seconds>3600)throw new HttpError(400,'invalid_artifact_expiry');
 const headers=auth(db);headers.set('content-type','application/json');
 const response=await db.fetchImpl(storageURL(db,'object/sign/'+bucket+'/'+encoded),{method:'POST',headers,body:JSON.stringify({expiresIn:seconds}),signal:AbortSignal.timeout(10000),redirect:'error'});
 if(!response.ok){await response.body?.cancel();throw new HttpError(503,'artifact_storage_unavailable');}
 let value:unknown;
 try{value=await storageMetadata(response);}catch{throw new HttpError(502,'invalid_artifact_signature');}
 const raw=(value as {signedURL?:unknown}|null)?.signedURL;
 if(typeof raw!=='string'||raw.length>8192)throw new HttpError(502,'invalid_artifact_signature');
 let url:URL;
 try{url=new URL(raw.startsWith('/object/')?db.config.url+'/storage/v1'+raw:raw,db.config.url);}catch{throw new HttpError(502,'invalid_artifact_signature');}
 const base=new URL(db.config.url);
 if(url.origin!==base.origin||url.username||url.password||url.hash||url.pathname!=='/storage/v1/object/sign/'+bucket+'/'+encoded||!url.searchParams.get('token')||[...url.searchParams.keys()].some(key=>key!=='token'))throw new HttpError(502,'invalid_artifact_signature');
 return url.href;
}
export async function deleteArtifacts(db:Database,paths:string[]):Promise<void>{
 if(!paths.length)return;
 if(paths.length>100)throw new HttpError(400,'invalid_artifact_count');
 for(const path of paths)encodedPath(path);
 const headers=auth(db);headers.set('content-type','application/json');
 const response=await db.fetchImpl(storageURL(db,'object/'+bucket),{method:'DELETE',headers,body:JSON.stringify({prefixes:paths}),signal:AbortSignal.timeout(30000),redirect:'error'});
 await response.body?.cancel();if(!response.ok)throw new HttpError(503,'artifact_storage_unavailable');
}

export async function listTaskArtifacts(db:Database,taskId:string):Promise<string[]>{
 imageArtifactPath(taskId,'request');
 const prefix='images/'+taskId;
 const headers=auth(db);headers.set('content-type','application/json');
 const response=await db.fetchImpl(storageURL(db,'object/list/'+bucket),{method:'POST',headers,body:JSON.stringify({prefix,limit:103,offset:0,sortBy:{column:'name',order:'asc'}}),signal:AbortSignal.timeout(10000),redirect:'error'});
 if(!response.ok){await response.body?.cancel();throw new HttpError(503,'artifact_storage_unavailable');}
 const entries=await storageMetadata(response,262144);
 if(!Array.isArray(entries)||entries.length>102)throw new HttpError(502,'invalid_artifact_listing');
 return entries.map(entry=>{
  if(typeof entry?.name!=='string')throw new HttpError(502,'invalid_artifact_listing');
  const path=prefix+'/'+entry.name;
  try{encodedPath(path);}catch{throw new HttpError(502,'invalid_artifact_listing');}
  return path;
 });
}
