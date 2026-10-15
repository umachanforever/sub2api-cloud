import {ANTIGRAVITY_MODELS} from './antigravity_catalog.ts';
import {Database,HttpError} from './db.ts';
import {json} from './http.ts';
import {allowsModel,type ModelAllowlist} from './model_policy.ts';
import {hashKey} from './validation.ts';

export async function antigravityDiscovery(request:Request,token:string,db:Database):Promise<Response>{
  if(db.config.dataModel!=='native')throw new HttpError(501,'native_data_model_required');
  const clientIp=request.headers.get('cf-connecting-ip')?.trim()||request.headers.get('x-real-ip')?.trim()||request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||null;
  const policy=await db.rpc<{model_allowlist?:ModelAllowlist;error?:string;status?:number}>('s2a_personal_key_policy',{p_key_hash:await hashKey(token),p_client_ip:clientIp});
  if(policy.error)throw new HttpError(policy.status??403,policy.error);
  return json(200,{object:'list',data:ANTIGRAVITY_MODELS.filter(model=>allowsModel(policy.model_allowlist,model.id))});
}
