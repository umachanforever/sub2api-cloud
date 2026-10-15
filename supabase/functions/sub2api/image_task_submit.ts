import {Database,HttpError} from './db.ts';
import {hashKey,readBody} from './validation.ts';
import {imageForm,validateImageEdit} from './image_input.ts';
import {imageArtifactPath,putArtifact} from './artifact_storage.ts';
import {requestBodyLimit} from './request_limits.ts';
import {json} from './http.ts';

export class ImageTaskSubmitError extends HttpError {
 readonly taskId:string;
 constructor(error:unknown,taskId:string){
  super(error instanceof HttpError?error.status:503,error instanceof HttpError?error.code:'image_task_persistence_unavailable');
  this.taskId=taskId;
 }
}
export type ImageTaskView={id:string;task_id:string;object:string;status:'processing'|'completed'|'failed';created_at:number;expires_at:number;completed_at?:number;http_status?:number;error?:unknown;result_path?:string;result_hash?:string};
export function checkImageTask(value:unknown,id:string):ImageTaskView{
 if(value&&typeof value==='object'&&typeof (value as {error?:unknown}).error==='string'){
  const error=value as {error:string;status?:number};
  throw new HttpError(typeof error.status==='number'&&Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:503,error.error);
 }
 const task=value as ImageTaskView|null;
 if(!task||task.id!==id||task.task_id!==id||task.object!=='image.generation.task'||!['processing','completed','failed'].includes(task.status)||!Number.isSafeInteger(task.created_at)||!Number.isSafeInteger(task.expires_at))throw new HttpError(503,'invalid_image_task_response');
 return task;
}
export async function imageTaskRPC(db:Database,name:string,args:Record<string,unknown>,id:string):Promise<ImageTaskView>{
 for(let attempt=0;;attempt++){
  try{return checkImageTask(await db.rpc(name,args),id);}
  catch(error){if(attempt===1||error instanceof HttpError&&error.status!==503)throw error;}
 }
}
export function imageTaskClientIP(request:Request):string|null{
 return request.headers.get('cf-connecting-ip')?.trim()||request.headers.get('x-real-ip')?.trim()||request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||null;
}
export async function imageBytesHash(bytes:Uint8Array):Promise<string>{
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource)),byte=>byte.toString(16).padStart(2,'0')).join('');
}
async function wireBytes(request:Request,limit:number):Promise<Uint8Array>{
 const length=request.headers.get('content-length');
 if(length&&/^\d+$/.test(length)&&Number(length)>limit){await request.body?.cancel();throw new HttpError(413,'request_too_large');}
 const reader=request.body?.getReader();if(!reader)throw new HttpError(400,'invalid_request');
 const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>limit)throw new HttpError(413,'request_too_large');chunks.push(chunk.value);}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
// This stages work only; the authenticated worker is responsible for inference.
export async function imageTaskSubmit(request:Request,operation:'generations'|'edits',token:string,db:Database):Promise<Response>{
 if(request.method!=='POST')throw new HttpError(405,'method_not_allowed');
 if(db.config.dataModel!=='native')throw new HttpError(501,'native_data_model_required');
 const keyHash=await hashKey(token),clientIP=imageTaskClientIP(request);
 const policy=await db.rpc<{platform?:string;error?:string;status?:number}|null>('s2a_personal_key_policy',{p_key_hash:keyHash,p_client_ip:clientIP});
 if(!policy)throw new HttpError(503,'database_unavailable');
 if(policy.error)throw new HttpError(policy.status??403,policy.error);
 if(!['openai','grok'].includes(policy.platform??''))throw new HttpError(400,'image_platform_unsupported');
 const contentType=request.headers.get('content-type')??'';
 const multipart=/^multipart\/form-data(?:;|$)/i.test(contentType);
 if(contentType.length>512||!(multipart&&operation==='edits'||/^application\/json(?:;|$)/i.test(contentType)))throw new HttpError(415,'unsupported_media_type');
 const limit=requestBodyLimit('/v1/images/'+operation,db.config.requestLimits);
 const bytes=await wireBytes(request,Math.min(limit,256*1024*1024));
 const copy=new Request('https://image-task.invalid',{method:'POST',headers:{'content-type':contentType},body:bytes as BodyInit});
 const parsed=multipart?await imageForm(copy,limit):undefined;
 const body=parsed?.body??await readBody(copy,limit);
 if(body.stream!==undefined&&typeof body.stream!=='boolean')throw new HttpError(400,'invalid_stream');
 if(body.stream===true)throw new HttpError(400,'async_image_stream_unsupported');
 if(typeof body.prompt!=='string'||!body.prompt.trim()||body.prompt.length>65536)throw new HttpError(400,'invalid_request');
 if(operation==='edits'&&!multipart)validateImageEdit({...body});
 let model=body.model;
 if(model===undefined||typeof model==='string'&&!model.trim()){
  if(policy.platform==='grok')throw new HttpError(400,'image_model_required');
  model='gpt-image-2';
 }
 if(typeof model!=='string'||!/^[a-zA-Z0-9._:-]{1,200}$/.test(model)||model==='__models__')throw new HttpError(400,'invalid_request');
 const id='imgtask_'+crypto.randomUUID().replaceAll('-','');
 try{
  await imageTaskRPC(db,'s2a_personal_image_task_prepare',{p_key_hash:keyHash,p_id:id,p_model:model,p_operation:operation,p_content_type:contentType,p_body_hash:await imageBytesHash(bytes),p_body_size:bytes.length,p_client_ip:clientIP},id);
  // Upload retries overwrite the same private object, never submit inference.
  for(let attempt=0;;attempt++){
   try{await putArtifact(db,imageArtifactPath(id,'request'),bytes,contentType);break;}
   catch(error){if(attempt===1||error instanceof HttpError&&error.status!==503)throw error;}
  }
  const task=await imageTaskRPC(db,'s2a_personal_image_task_ready',{p_key_hash:keyHash,p_id:id,p_client_ip:clientIP},id);
  const url=new URL(request.url);url.pathname=url.pathname.replace(/\/images\/(?:generations|edits)\/async$/,'/images/tasks/'+id);url.search='';url.hash='';
  const response=json(202,{id,task_id:id,object:task.object,status:task.status,created_at:task.created_at,expires_at:task.expires_at,poll_url:url.href});
  response.headers.set('location',url.href);response.headers.set('retry-after','3');return response;
 }catch(error){throw new ImageTaskSubmitError(error,id);}
}
