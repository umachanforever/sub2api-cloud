import {DEFAULT_PROVIDER_CATALOGS} from './provider_models.ts';
import {COMPOSITE_DEFAULT_IDS} from './composite_defaults.ts';
import {allowlistedModels,type ModelAllowlist} from './model_policy.ts';
import {HttpError} from './db.ts';
export type CompositeCatalogSources={sources:{platform:string;passthrough:boolean;mapping:Record<string,string>}[];routes:{model:string;match_type:string;platform:string;endpoint:string;upstream_model:string}[]};
const precedence=['anthropic','gemini','openai','antigravity','grok','kimi','zhipu','deepseek','minimax','opencode_go','typesafe','command_code','cline'];
function defaults(platform:string):string[]{return DEFAULT_PROVIDER_CATALOGS[platform]?.map(entry=>String(entry.id))??COMPOSITE_DEFAULT_IDS[platform]??[];}
// A standard catalog is aggregated from every eligible platform, without acquiring
// one provider's credentials or consuming an inference concurrency slot.
export function compositeModelCatalog(input:CompositeCatalogSources,allowlist?:ModelAllowlist,modelId?:string){
 if(!input||!Array.isArray(input.sources)||!Array.isArray(input.routes))throw new HttpError(503,'invalid_composite_catalog');
 const ids=new Set<string>();
 for(const platform of precedence){
  const accounts=input.sources.filter(source=>source.platform===platform);
  if(!accounts.length)continue;
  const mapped=new Set(accounts.filter(source=>!(platform==='openai'&&source.passthrough)).flatMap(source=>Object.keys(source.mapping)).map(id=>id.trim()).filter(Boolean));
  if(!mapped.size||platform==='openai'&&accounts.some(source=>source.passthrough||!Object.keys(source.mapping).length))for(const id of defaults(platform))mapped.add(id);
  for(const id of [...mapped].sort())ids.add(id);
 }
 for(const route of input.routes)if(route.match_type==='exact'&&route.model.trim())ids.add(route.model.trim());
 // Match the original empty-catalog fallback; TypeSafe stays explicit.
 if(!ids.size)for(const platform of precedence)if(platform!=='typesafe')for(const id of defaults(platform))ids.add(id);
 const data=allowlistedModels(allowlist,[...ids]).map(id=>({id,object:'model',type:'model',created:0,owned_by:'composite',display_name:id}));
 if(modelId!==undefined){const entry=data.find(entry=>entry.id===modelId);if(!entry)throw new HttpError(404,'model_not_found');return entry;}
 return {object:'list',data};
}
