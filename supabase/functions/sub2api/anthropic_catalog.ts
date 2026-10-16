import {DEFAULT_PROVIDER_CATALOGS} from './provider_models.ts';
import {allowlistedModels,type ModelAllowlist} from './model_policy.ts';
import {HttpError} from './db.ts';
import {compositeCodexCatalog,type CompositeCapabilitySource} from './composite_catalog.ts';

// Standard Anthropic discovery uses group mappings, not provider credentials.
export function anthropicModelCatalog(available:string[],allowlist?:ModelAllowlist,model?:string):Record<string,unknown> {
  const defaults=DEFAULT_PROVIDER_CATALOGS.anthropic;
  let entries:Record<string,unknown>[];
  if(!available.length&&!allowlist?.enabled)entries=defaults.map(entry=>({...entry}));
  else {
    const source=allowlist?.enabled?[...new Set([...available,...defaults.map(entry=>String(entry.id))])]:available;
    entries=allowlistedModels(allowlist,source).map(id=>({id,type:'model',display_name:id,created_at:'2024-01-01T00:00:00Z'}));
  }
  if(model!==undefined){const entry=entries.find(entry=>entry.id===model);if(!entry)throw new HttpError(404,'model_not_found');return entry;}
  return {object:'list',data:entries};
}

export function anthropicCodexCatalog(available:string[],allowlist?:ModelAllowlist,capabilities:CompositeCapabilitySource[]=[]){
  const catalog=anthropicModelCatalog(available,allowlist) as {data:{id:string}[]};
  if(!catalog.data.length)return {models:[]};
  return compositeCodexCatalog({sources:[{platform:'anthropic',passthrough:false,mapping:Object.fromEntries(catalog.data.map(entry=>[entry.id,entry.id]))}],routes:[],capability_sources:capabilities},allowlist);
}
