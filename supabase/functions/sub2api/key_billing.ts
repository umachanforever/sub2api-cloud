import {Database,HttpError} from './db.ts';
import {json} from './http.ts';
import {hashKey} from './validation.ts';

export async function keyBilling(request:Request,token:string,db:Database):Promise<Response>{
  if(db.config.dataModel!=='native')throw new HttpError(501,'native_data_model_required');
  const clientIp=request.headers.get('cf-connecting-ip')?.trim()||request.headers.get('x-real-ip')?.trim()||request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||null;
  const value=await db.rpc<Record<string,unknown>&{error?:string;status?:number}>('s2a_personal_key_billing',{p_key_hash:await hashKey(token),p_client_ip:clientIp});
  if(value.error)throw new HttpError(value.status??403,value.error);
  return json(200,value);
}
