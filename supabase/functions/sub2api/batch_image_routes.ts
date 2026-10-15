import {batchImageModels} from './batch_image_models.ts';
import {Database,HttpError} from './db.ts';
import {hashKey,readBody} from './validation.ts';
import {requestBodyLimit} from './request_limits.ts';
import {imageTaskClientIP} from './image_task_submit.ts';
import {submitBatchImage} from './batch_image_submit.ts';
import {batchImageContent} from './batch_image_content.ts';
import {downloadBatchImages} from './batch_image_download.ts';
import {json} from './http.ts';
async function call(db:Database,name:string,args:Record<string,unknown>):Promise<Record<string,unknown>>{
 const row=await db.rpc<Record<string,unknown>>(name,args);
 if(!row||typeof row!=='object'||Array.isArray(row))throw new HttpError(503,'invalid_batch_response');
 if(typeof row.error==='string')throw new HttpError(typeof row.status==='number'?row.status:503,row.error);return row;
}
function number(value:string|null,fallback:number,min:number,max:number):number{
 if(value===null)return fallback;
 if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<min||Number(value)>max)throw new HttpError(400,'invalid_batch_pagination');return Number(value);
}
function listFilters(url:URL):Record<string,unknown>{
 const filters:Record<string,unknown>={};
 for(const key of ['status','task_name']){const value=url.searchParams.get(key)?.trim();if(value)filters[key]=value;}
 const downloaded=url.searchParams.get('downloaded')?.trim().toLowerCase();
 if(downloaded&&!['all'].includes(downloaded)){
  if(['true','1','yes','downloaded'].includes(downloaded))filters.downloaded=true;
  else if(['false','0','no','not_downloaded'].includes(downloaded))filters.downloaded=false;
  else throw new HttpError(400,'invalid_batch_downloaded_filter');
 }
 for(const key of ['from','to']){
  const value=url.searchParams.get(key)?.trim();if(!value)continue;
  const time=/^\d+$/.test(value)?Number(value)*1000:Date.parse(value);
  if(!Number.isFinite(time)||!Number.isFinite(new Date(time).getTime()))throw new HttpError(400,'invalid_batch_time_filter');
  filters[key]=new Date(time).toISOString();
 }
 return filters;
}
export async function batchImageRoute(request:Request,pathname:string,token:string,db:Database):Promise<Response>{
 if(!token)throw new HttpError(401,'unauthorized');
 if(db.config.dataModel!=='native')throw new HttpError(501,'native_data_model_required');
 const path=pathname.replace(/^\/images\//,'/v1/images/'),url=new URL(request.url),base='/v1/images/batches',keyHash=await hashKey(token),clientIP=imageTaskClientIP(request),args={p_key_hash:keyHash,p_client_ip:clientIP};
 if(path===base+'/models'){if(request.method!=='GET')throw new HttpError(405,'method_not_allowed');return json(200,await batchImageModels(db,keyHash,clientIP));}
 if(path===base){
  if(request.method==='GET')return json(200,await call(db,'s2a_batch_image_list',{...args,p_limit:number(url.searchParams.get('limit'),20,1,100),p_offset:number(url.searchParams.get('cursor')??url.searchParams.get('offset'),0,0,1000000),p_filters:listFilters(url)}));
  if(request.method==='POST'){
   const idempotency=request.headers.get('idempotency-key');
   if(idempotency!==null&&(!idempotency.trim()||new TextEncoder().encode(idempotency).length>255||/[\u0000-\u001f]/.test(idempotency)))throw new HttpError(400,'invalid_idempotency_key');
   const id=idempotency===null?undefined:'imgbatch_'+(await hashKey('batch\0'+keyHash+'\0'+idempotency)).slice(0,32);
   const submitted=await submitBatchImage(db,keyHash,await readBody(request,requestBodyLimit(path,db.config.requestLimits)),{id,clientIP,signal:request.signal});
   return json(200,await call(db,'s2a_batch_image_read',{...args,p_id:submitted.id}));
  }
  throw new HttpError(405,'method_not_allowed');
 }
 const match=/^\/v1\/images\/batches\/(imgbatch_[a-f0-9]{32})(?:\/(items|download|cancel|outputs)(?:\/([^/]+)\/content)?)?$/.exec(path);
 if(!match)throw new HttpError(404,'not_found');
 const id=match[1],operation=match[2];
 if(!operation&&request.method==='GET')return json(200,await call(db,'s2a_batch_image_read',{...args,p_id:id}));
 if(!operation&&request.method==='DELETE')return json(200,await call(db,'s2a_batch_image_delete',{...args,p_id:id,p_hide:true}));
 if(operation==='cancel'&&!match[3]&&request.method==='POST')return json(200,await call(db,'s2a_batch_image_cancel',{...args,p_id:id}));
 if(operation==='outputs'&&!match[3]&&request.method==='DELETE')return json(200,await call(db,'s2a_batch_image_delete',{...args,p_id:id,p_hide:false}));
 if(operation==='download'&&!match[3]&&request.method==='GET')return downloadBatchImages(db,keyHash,id,clientIP);
 if(operation==='items'&&request.method==='GET'){
  if(match[3]){
   let customID:string;try{customID=decodeURIComponent(match[3]);}catch{throw new HttpError(400,'invalid_batch_custom_id');}
   return batchImageContent(db,keyHash,id,customID,number(url.searchParams.get('image_index'),0,0,1000000),clientIP);
  }
  const snapshot=await call(db,'s2a_batch_image_read',{...args,p_id:id});
  if(!Array.isArray(snapshot.items))throw new HttpError(503,'invalid_batch_response');
  const status=url.searchParams.get('status');if(status&&!['pending','success','failed','cancelled'].includes(status))throw new HttpError(400,'invalid_batch_item_status');
  const items=snapshot.items.filter(item=>!status||item.status===status),offset=number(url.searchParams.get('cursor')??url.searchParams.get('offset'),0,0,1000000),limit=number(url.searchParams.get('limit'),20,1,200);
  return json(200,{items:items.slice(offset,offset+limit),total:items.length,limit,offset});
 }
 throw new HttpError(405,'method_not_allowed');
}
