import {Database,HttpError} from './db.ts';
import {allowsModel,type ModelAllowlist} from './model_policy.ts';
const defaults=['gemini-2.0-flash-exp-image-generation','gemini-2.5-flash-image','gemini-3-pro-image','gemini-3-pro-image-preview','gemini-3.1-flash-image','gemini-3.1-flash-image-preview','gemini-3.1-flash-lite-image'];
function matches(pattern:string,model:string):boolean{return pattern.endsWith('*')?model.startsWith(pattern.slice(0,-1)):model===pattern;}
export async function batchImageModels(db:Database,keyHash:string,clientIP:string|null):Promise<Record<string,unknown>>{
 const result=await db.rpc<{error?:string;status?:number;sources:{provider:string;mapping:Record<string,unknown>}[];model_allowlist?:ModelAllowlist}>('s2a_batch_image_model_sources',{p_key_hash:keyHash,p_client_ip:clientIP,p_vertex_enabled:Boolean(db.config.vertexBatch?.bucket)});
 if(result?.error)throw new HttpError(result.status??503,result.error);
 if(!Array.isArray(result?.sources))throw new HttpError(503,'invalid_batch_model_sources');
 const data:{id:string;object:string;provider:string}[]=[];
 for(const provider of ['gemini_api','vertex']){
  const models=new Set<string>();
  for(const source of result.sources){
   if(source.provider!==provider)continue;
   if(!source.mapping||typeof source.mapping!=='object'||Array.isArray(source.mapping))throw new HttpError(503,'invalid_batch_model_sources');
   for(const key of Object.keys(source.mapping)){
    const pattern=key.trim();if(!pattern||pattern.length>200)continue;
    for(const candidate of /[*?]/.test(pattern)?defaults.filter(model=>matches(pattern,model)):[pattern]){
     if(allowsModel(result.model_allowlist,candidate))models.add(candidate);
    }
   }
  }
  for(const id of [...models].sort())data.push({id,object:'image.batch.model',provider});
 }
 return {object:'list',data};
}
