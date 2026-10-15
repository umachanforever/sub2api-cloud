import {Database,HttpError} from './db.ts';
import {json} from './http.ts';
import {hashKey} from './validation.ts';

export function cachePage(url:URL):{size:number;before:string|null}{
  const raw=url.searchParams.get('pageSize')??'0';
  if(!/^\d+$/.test(raw))throw new HttpError(400,'invalid_page_size');
  const size=Number(raw);if(!Number.isSafeInteger(size))throw new HttpError(400,'invalid_page_size');
  const token=url.searchParams.get('pageToken');let before:string|null=null;
  if(token){
    try{
      if(!/^[A-Za-z0-9_-]+$/.test(token))throw Error();
      before=atob(token.replace(/-/g,'+').replace(/_/g,'/'));
      if(!/^[1-9][0-9]*$/.test(before)||BigInt(before)>9223372036854775807n||btoa(before).replace(/=+$/,'')!==token)throw Error();
    }catch{throw new HttpError(400,'invalid_page_token');}
  }
  return {size:Math.min(size||50,1000),before};
}
export async function geminiCacheRead(request:Request,path:string,token:string,db:Database):Promise<Response>{
  if(db.config.dataModel!=='native')throw new HttpError(501,'native_data_model_required');
  const name=path==='/v1beta/cachedContents'?null:path.slice('/v1beta/'.length);
  if(name&&!/^cachedContents\/[a-zA-Z0-9_-]{1,64}$/.test(name))throw new HttpError(400,'invalid_cached_content');
  const page=name?{size:50,before:null}:cachePage(new URL(request.url));
  const ip=request.headers.get('cf-connecting-ip')?.trim()||request.headers.get('x-real-ip')?.trim()||request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||null;
  const result=await db.rpc<Record<string,unknown>&{error?:string;status?:number}>('s2a_personal_cache_read',{p_key_hash:await hashKey(token),p_name:name,p_page_size:page.size,p_before:page.before,p_client_ip:ip});
  if(result?.error)throw new HttpError(result.status??403,result.error);
  return json(200,result);
}
