import {codexCatalogDescriptor} from './codex_catalog.ts';
import {mappedTarget} from './model_mapping.ts';
import {defaultSolModel} from './codex_models.ts';
import {DEFAULT_PROVIDER_CATALOGS} from './provider_models.ts';
import {COMPOSITE_DEFAULT_IDS} from './composite_defaults.ts';
import {allowlistedModels,type ModelAllowlist} from './model_policy.ts';
import {HttpError} from './db.ts';
export type CompositeCatalogSources={sources:{platform:string;passthrough:boolean;mapping:Record<string,string>}[];routes:{model:string;match_type:string;platform:string;endpoint:string;upstream_model:string}[]};
const precedence=['anthropic','gemini','openai','antigravity','grok','kimi','zhipu','deepseek','minimax','opencode_go','typesafe','command_code','cline'];
function defaults(platform:string):string[]{return DEFAULT_PROVIDER_CATALOGS[platform]?.map(entry=>String(entry.id))??COMPOSITE_DEFAULT_IDS[platform]??[];}
// A standard catalog is aggregated from every eligible platform, without acquiring
// one provider's credentials or consuming an inference concurrency slot.
export function compositeModelCatalog(input:CompositeCatalogSources,allowlist?:ModelAllowlist,modelId?:string,responsesOnly=false){
 if(!input||!Array.isArray(input.sources)||!Array.isArray(input.routes))throw new HttpError(503,'invalid_composite_catalog');
 const ids=new Set<string>();
 for(const platform of precedence){
  if(responsesOnly&&platform==='typesafe')continue;
  const accounts=input.sources.filter(source=>source.platform===platform);
  if(!accounts.length)continue;
  const mapped=new Set(accounts.filter(source=>!(platform==='openai'&&source.passthrough)).flatMap(source=>Object.keys(source.mapping)).map(id=>id.trim()).filter(Boolean));
  if(!mapped.size||platform==='openai'&&accounts.some(source=>source.passthrough||!Object.keys(source.mapping).length))for(const id of defaults(platform))mapped.add(id);
  for(const id of [...mapped].sort())ids.add(id);
 }
 for(const route of input.routes)if(route.match_type==='exact'&&route.model.trim()&&(!responsesOnly||['any','responses'].includes(route.endpoint)))ids.add(route.model.trim());
 // Match the original empty-catalog fallback; TypeSafe stays explicit.
 if(!ids.size)for(const platform of precedence)if(platform!=='typesafe')for(const id of defaults(platform))ids.add(id);
 const data=allowlistedModels(allowlist,[...ids]).filter(id=>!responsesOnly||selectedRoute(input,id)?.platform!=='typesafe').map(id=>({id,object:'model',type:'model',created:0,owned_by:'composite',display_name:id}));
 if(modelId!==undefined){const entry=data.find(entry=>entry.id===modelId);if(!entry)throw new HttpError(404,'model_not_found');return entry;}
 return {object:'list',data};
}

function selectedRoute(input:CompositeCatalogSources,model:string){
 return input.routes.map((route,index)=>({route,index})).filter(({route})=>['any','responses'].includes(route.endpoint)&&(route.match_type==='exact'?route.model===model:model.startsWith(route.model)))
  .sort((a,b)=>Number(b.route.match_type==='exact')-Number(a.route.match_type==='exact')||Number(b.route.endpoint==='responses')-Number(a.route.endpoint==='responses')||b.route.model.length-a.route.model.length||a.index-b.index)[0]?.route;
}
export function compositeCodexCatalog(input:CompositeCatalogSources,allowlist?:ModelAllowlist){
 const catalog=compositeModelCatalog(input,allowlist,undefined,true) as {data:{id:string}[]};
 const models=[];
 for(const {id} of catalog.data){
  if(id.includes('*')||!codexCatalogDescriptor(id))continue;
  const route=selectedRoute(input,id),requested=route?.upstream_model||id;
  const targets=new Set(input.sources.filter(source=>!route||source.platform===route.platform).map(source=>mappedTarget(source.mapping,requested,source.platform)).filter((target):target is string=>typeof target==='string'));
  const target=targets.size===1?[...targets][0]:targets.size>1?'custom-model':requested;
  const descriptor=codexCatalogDescriptor(defaultSolModel(target)??target);
  if(!descriptor)continue;
  if(descriptor.slug!==id){descriptor.slug=id;descriptor.display_name=id;descriptor.description='Custom model routed through sub2api-cloud.';}
  models.push(descriptor);
 }
 return {models};
}
