import {HttpError} from './db.ts';
import {codexCatalogDescriptor} from './codex_catalog.ts';
export function modelMapping(value:unknown):Record<string,string> {
 if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length>500)throw new HttpError(400,'invalid_model_mapping');
 const entries=Object.entries(value).map(([pattern,target])=>{
  pattern=pattern.trim();
  if(!pattern || pattern.length>200 || /[\x00-\x1f\x7f]/.test(pattern) || pattern.replace(/\*$/,'').includes('*') || typeof target!=='string' || !target.trim() || target.length>200 || /[\x00-\x1f\x7f*]/.test(target))throw new HttpError(400,'invalid_model_mapping');
  return [pattern,target.trim()];
 });
 if(new Set(entries.map(([pattern])=>pattern)).size!==entries.length)throw new HttpError(400,'duplicate_model_mapping');
 return Object.fromEntries(entries);
}
export function accountMappingInput(body:Record<string,unknown>):Record<string,string>|undefined {
 const credentials=body.credentials;
 const nested=credentials && typeof credentials==='object' && !Array.isArray(credentials) ? credentials as Record<string,unknown> : undefined;
 if(body.model_mapping!==undefined && nested?.model_mapping!==undefined)throw new HttpError(400,'duplicate_model_mapping');
 const value=body.model_mapping ?? nested?.model_mapping;
 if(body.model_mapping===null || nested?.model_mapping===null)throw new HttpError(400,'invalid_model_mapping');
 if(value===undefined)return undefined;
 const mapping=modelMapping(value);
 if(nested?.model_mapping!==undefined) {const {model_mapping:_,...remaining}=nested;body.credentials=remaining;}
 return mapping;
}

export type ModelSources={mapping:Record<string,string>;include_upstream:boolean};
export function mappedTarget(mapping:Record<string,string>,model:string,platform:string):string|undefined {
 const lookup=(name:string)=>Object.hasOwn(mapping,name)?mapping[name]:Object.keys(mapping).filter(pattern=>pattern.endsWith('*')&&name.startsWith(pattern.slice(0,-1))).sort((a,b)=>new TextEncoder().encode(b).length-new TextEncoder().encode(a).length || (a<b?-1:a>b?1:0)).map(pattern=>mapping[pattern])[0];
 const exact=lookup(model);if(exact!==undefined)return exact;
 const normalized=['gemini','antigravity'].includes(platform)&&model.trim()==='gemini-3.1-pro-preview-customtools'?'gemini-3.1-pro-preview':model.trim();
 return normalized!==model?lookup(normalized):undefined;
}
export function mappedCatalog(value:Record<string,any>,sources:ModelSources|undefined,platform:string):Record<string,any> {
 if(!sources || !Object.keys(sources.mapping).length)return value;
 const field=Array.isArray(value.data)?'data':Array.isArray(value.models)?'models':null;if(!field)return value;
 const idField=field==='data'?'id':['gemini','antigravity'].includes(platform)?'name':'slug';
 const id=(entry:Record<string,any>)=>String(entry?.[idField]).replace(/^models\//,'');
 const original=value[field] as Record<string,any>[],entries=sources.include_upstream?[...original]:[];
 for(const [alias,target] of Object.entries(sources.mapping)) {
  if(entries.some(entry=>id(entry)===alias))continue;
  const metadata=original.find(entry=>id(entry)===target.replace(/^models\//,''))??(idField==='slug'?codexCatalogDescriptor(alias):undefined);
  if(idField==='slug' && alias.endsWith('*'))continue;
  entries.push({...metadata,...(field==='data'?{object:'model',created:metadata?.created??0,owned_by:metadata?.owned_by??platform}:{}),[idField]:idField==='name'?`models/${alias}`:alias});
 }
 return {...value,[field]:entries};
}
