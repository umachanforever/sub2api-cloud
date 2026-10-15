import {Database,HttpError} from './db.ts';
type Item=Record<string,any>;
export type GeminiCacheBinding={account_id:string;upstream_name:string;upstream_model:string;error?:string;status?:number};
export function geminiCacheName(body:Item):string|undefined{
  if(body.generate_content_request&&typeof body.generate_content_request==='object'&&('cachedContent' in body.generate_content_request||'cached_content' in body.generate_content_request))throw new HttpError(400,'invalid_cached_content');
  let name:string|undefined;
  for(const parent of [body,body.generateContentRequest]){
    if(!parent||typeof parent!=='object'||Array.isArray(parent))continue;
    if('cached_content' in parent)throw new HttpError(400,'invalid_cached_content');
    const value=parent.cachedContent;if(value===undefined||value===null||typeof value==='string'&&!value.trim())continue;
    if(typeof value!=='string'||!/^cachedContents\/[a-zA-Z0-9_-]{1,64}$/.test(value.trim()))throw new HttpError(400,'invalid_cached_content');
    if(name&&name!==value.trim())throw new HttpError(400,'conflicting_cached_content');name=value.trim();
  }
  return name;
}
export async function resolveGeminiCache(db:Database,keyHash:string,name:string,model:string,clientIp:string|null):Promise<GeminiCacheBinding>{
  const value=await db.rpc<GeminiCacheBinding>('s2a_personal_cache_resolve',{p_key_hash:keyHash,p_name:name,p_model:model,p_client_ip:clientIp});
  if(value?.error)throw new HttpError(value.status??404,value.error);
  if(!value||!/^\d+$/.test(value.account_id)||!/^cachedContents\/[a-zA-Z0-9_-]+$/.test(value.upstream_name)||typeof value.upstream_model!=='string'||!value.upstream_model)throw new HttpError(503,'invalid_cache_binding');
  return value;
}
export function rewriteGeminiCache(body:Item,binding:GeminiCacheBinding):Item{
  const value=structuredClone(body);
  for(const parent of [value,value.generateContentRequest])if(parent&&typeof parent.cachedContent==='string'&&parent.cachedContent.trim())parent.cachedContent=binding.upstream_name;
  return value;
}

// Inspect raw member names before JSON.parse can discard duplicate cache references.
export function validateGeminiCacheJson(source:string):void{
  JSON.parse(source);
  const tokens=source.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g)??[];
  let index=0;
  const value=(scope:'root'|'nested'|'other'):void=>{
    const token=tokens[index++];
    if(token==='{'){
      const seen=new Set<string>();
      while(tokens[index]!=='}'){
        const key=JSON.parse(tokens[index++]);index++;
        if(scope!=='other'&&(key==='cachedContent'||scope==='root'&&key==='generateContentRequest')){
          if(seen.has(key))throw new HttpError(400,'duplicate_cached_content_field');seen.add(key);
        }
        value(scope==='root'&&key==='generateContentRequest'?'nested':'other');
        if(tokens[index]!==',')break;index++;
      }
      index++;
    }else if(token==='['){
      while(tokens[index]!==']'){value('other');if(tokens[index]!==',')break;index++;}index++;
    }
  };
  value('root');
}
