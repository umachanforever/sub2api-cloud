import {applyCodexCatalogPolicy} from './codex_catalog_policy.ts';
import {apiKeyCodexCapabilities,astraCodexModel} from './api_key_codex_capabilities.ts';
import {originalCodexMetadata} from './original_chat_bridge.ts';
import {modelMetadata} from './model_capabilities.ts';
import {codexCatalogDescriptor} from './codex_catalog.ts';
import {mappedTarget} from './model_mapping.ts';
import {defaultSolModel,modernCodexModel} from './codex_models.ts';
import {DEFAULT_PROVIDER_CATALOGS} from './provider_models.ts';
import {COMPOSITE_DEFAULT_IDS} from './composite_defaults.ts';
import {allowlistedModels,type ModelAllowlist} from './model_policy.ts';
import {HttpError} from './db.ts';
export type CompositeCapabilitySource={id?:string;metadata?:{models?:Record<string,Record<string,any>>};platform:string;type:string;passthrough:boolean;official:boolean;mapping:Record<string,string>;modalities:Record<string,unknown>};
export type CompositeCatalogSources={model_routing?:Record<string,(string|number)[]>;capability_sources?:CompositeCapabilitySource[];sources:{platform:string;passthrough:boolean;mapping:Record<string,string>}[];routes:{model:string;match_type:string;platform:string;endpoint:string;upstream_model:string}[]};
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
function codexSelection(input:CompositeCatalogSources,id:string){
 const route=selectedRoute(input,id),requested=route?.upstream_model||id;
 const blocked=!route&&input.routes.some(entry=>entry.match_type==='exact'?entry.model===id:id.startsWith(entry.model));
 const sources=input.capability_sources??input.sources;
 const owners=new Set(sources.filter(source=>Object.hasOwn(source.mapping,requested)&&source.mapping[requested]?.trim()).map(source=>source.platform));
 const platform=route?.platform??(blocked?undefined:owners.size===1?[...owners][0]:owners.size>1?undefined:detectedPlatform(requested));
 const targets=new Set(sources.filter(source=>source.platform===platform).map(source=>mappedTarget(source.mapping,requested,source.platform)).filter((target):target is string=>typeof target==='string'));
 // An explicit Responses route defines descriptor identity directly. Account
 // mappings still participate in per-account metadata and capability lookup.
 const target=route?requested:!blocked&&targets.size===1?[...targets][0]:id;
 return {requested,platform,target,resolved:platform!==undefined};
}
function detectedPlatform(model:string):string|undefined{
 model=model.trim().toLowerCase().replace(/^models\//,'');
 const slash=model.indexOf('/');
 if(slash>0){const provider=model.slice(0,slash).trim(),known:Record<string,string>={anthropic:'anthropic',claude:'anthropic',openai:'openai',chatgpt:'openai',google:'gemini','google-ai-studio':'gemini',gemini:'gemini',xai:'grok','x-ai':'grok',grok:'grok',kimi:'kimi',moonshot:'kimi',zhipu:'zhipu',glm:'zhipu',bigmodel:'zhipu',deepseek:'deepseek',minimax:'minimax',typesafe:'typesafe',jev:'typesafe'};if(Object.hasOwn(known,provider))return known[provider];model=model.slice(slash+1).trim().replace(/^models\//,'');}
 if(/^(anthropic\.claude-|claude-)/.test(model))return 'anthropic';
 if(/^(gpt-|chatgpt-|codex-|text-embedding-|text-moderation-|omni-moderation-|dall-e-|tts-|whisper-|o[1345]($|-))/.test(model))return 'openai';
 if(/^(gemini-|learnlm-)/.test(model))return 'gemini';
 if(model==='grok'||model.startsWith('grok-'))return 'grok';
 if(['k3','k3-256k'].includes(model)||/^(kimi-|moonshot-)/.test(model))return 'kimi';
 if(model.startsWith('glm-'))return 'zhipu';
 if(model.startsWith('deepseek-'))return 'deepseek';
 if(/^(minimax-|abab[567])/.test(model))return 'minimax';
 if(model.startsWith('jev-'))return 'typesafe';
}
function sourceImageInput(source:CompositeCapabilitySource,target:string):boolean{
 if(!['openai','grok','deepseek','opencode_go'].includes(source.platform))return false;
 const canonical=target.trim().toLowerCase().split('/').at(-1)!;
 if(source.platform==='grok')return source.official&&['grok-4.3','grok-4.5','grok-4.6','grok-4.7','grok-build-0.1','grok-4.20-0309-reasoning','grok-4.20-0309-non-reasoning','grok-4.20-multi-agent-0309'].includes(canonical);
 const raw=source.modalities[target],modalities=Array.isArray(raw)?raw.filter(value=>value==='text'||value==='image'):[];
 if(modalities.length){if(source.platform==='openai'&&source.official&&astraCodexModel(target))return true;return modalities.includes('image');}
 if(canonical==='deepseek-v4-flash-vision-exp')return source.type==='apikey';
 return source.platform==='openai'&&['oauth','apikey'].includes(source.type)&&(astraCodexModel(target)||['gpt-6-sol','gpt-6-luna','gpt-6-astra','gpt-6.1-sol'].includes(modernCodexModel(canonical)?.id??'')||/^(?:gpt-5|gpt-4o|gpt-4\.1|gpt-4\.5|gpt-4-turbo|gpt-4-vision)/.test(canonical));
}
function sourceSupports(source:CompositeCapabilitySource,model:string):boolean{
 if(source.platform==='openai'&&source.passthrough)return true;
 if(Object.keys(source.mapping).length)return mappedTarget(source.mapping,model,source.platform)!==undefined;
 if(source.platform==='deepseek')return ['deepseek-flash','deepseek-v4-pro','deepseek-v4-flash','deepseek-v4-flash-vision-exp','deepseek-v4-pro-0813'].includes(model.trim().toLowerCase().replace(/(?:\[1m\])+$/i,''));
 if(source.platform==='openai'&&source.type==='oauth'){
  const id=model.trim().toLowerCase().split('/').at(-1)!;
  return !['k3','k3-256k'].includes(id)&&!['deepseek-','glm-','kimi-','moonshot-','qwen-','qwen2-','qwen3-','qwen4-','qwq-','minimax-','gemini-','gemma-','grok-','doubao-','hunyuan-','llama-','llama2-','llama3-','meta-llama','mistral-','mixtral-','baichuan-','ernie-','step-','seed-','yi-'].some(prefix=>id.startsWith(prefix));
 }
 return true;
}
function imageInput(input:CompositeCatalogSources,platform:string|undefined,model:string):boolean{
 const candidates=(input.capability_sources??[]).filter(source=>source.platform===platform&&sourceSupports(source,model));
 return candidates.length>0&&candidates.every(source=>sourceImageInput(source,mappedTarget(source.mapping,model,source.platform)??model));
}
export function compositeCodexCatalog(input:CompositeCatalogSources,allowlist?:ModelAllowlist){
 const catalog=compositeModelCatalog(input,allowlist,undefined,true) as {data:{id:string}[]};
 const models=[];
 for(const {id} of catalog.data){
  if(id.includes('*')||!codexCatalogDescriptor(id))continue;
  const {requested,platform,target}=codexSelection(input,id);
  const descriptor=codexCatalogDescriptor(defaultSolModel(target)??target);
  if(!descriptor)continue;
  if(descriptor.slug!==id){descriptor.slug=id;descriptor.display_name=id;descriptor.description='Custom model routed through sub2api-cloud.';}
  descriptor.input_modalities=imageInput(input,platform,requested)?['text','image']:['text'];
  models.push(descriptor);
 }
 return applyCodexCatalogPolicy({models},allowlist);
}

// Keep candidate selection outside WASM; the original Go functions calculate
// metadata intersections and descriptor updates without database dependencies.
export async function completeCompositeCodexCatalog(input:CompositeCatalogSources,allowlist?:ModelAllowlist){
 const body=compositeCodexCatalog(input,allowlist);
 const fields=['display_name','description','default_reasoning_level','supported_reasoning_levels','input_modalities','context_window','max_context_window'];
 for(const descriptor of body.models){
  const id=descriptor.slug,{requested,platform,resolved}=codexSelection(input,id);
  const all=input.capability_sources??[];
  const rules=input.model_routing??{},routed=rules[id]?.length?rules[id]:Object.entries(rules).find(([pattern,ids])=>pattern.endsWith('*')&&id.startsWith(pattern.slice(0,-1))&&ids.length)?.[1];
  const accounts=all.filter(source=>source.platform===platform&&(!routed?.length||routed.map(String).includes(String(source.id))));
  const explicit=requested===id&&accounts.some(source=>Object.hasOwn(source.mapping,id)&&source.mapping[id]?.trim());
  const eligible=accounts.filter(source=>explicit?Object.hasOwn(source.mapping,id)&&source.mapping[id]?.trim():sourceSupports(source,requested));
  const targets=new Set(eligible.map(source=>mappedTarget(source.mapping,requested,source.platform)??requested));
  const candidates:Record<string,any>[]=[];let missing=false,alias=requested!==id;
  for(const source of eligible){
   const target=mappedTarget(source.mapping,requested,source.platform)??requested;
   alias||=target!==id;
   const raw=source.metadata?.models?.[target];
   const valid=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:undefined;
   if(!valid)missing=true;
   const metadata=valid?modelMetadata(target,{...valid.codex_tool_capabilities,...valid}):{};
   const defaults=source.platform==='openai'&&source.official?apiKeyCodexCapabilities(target):{};
   if(source.type==='oauth'){
    delete defaults.service_tiers;
    if(Object.keys(defaults).length){defaults.tool_mode='code_mode_only';defaults.use_responses_lite=true;}
   }else if(source.type!=='apikey')for(const key of Object.keys(defaults))delete defaults[key];
   const caps={...defaults,...('codex_tool_capabilities' in metadata?metadata.codex_tool_capabilities as Record<string,unknown>:{})};
   if(source.platform==='openai'&&source.type==='apikey'&&(astraCodexModel(target)||['gpt-6.1-sol','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna'].includes(target))&&caps.use_responses_lite===true)caps.use_responses_lite=false;
   candidates.push({...metadata,codex_tool_capabilities:caps});
  }
  const declaredTargets=new Set(all.filter(source=>Object.hasOwn(source.mapping,id)&&source.mapping[id]?.trim()).map(source=>source.platform+'\0'+source.mapping[id].trim()));
  const conflict=!routed?.length&&(!resolved&&declaredTargets.size>1||explicit&&targets.size>1&&missing);
  if(!candidates.length&&!conflict)continue;
  const patch=await originalCodexMetadata({model:id,candidates:candidates.length?candidates:[{}],descriptor:Object.fromEntries(fields.map(field=>[field,descriptor[field]])),missing:missing||conflict,conflict,public_alias:alias&&!conflict});
  Object.assign(descriptor,patch);
  if(imageInput(input,platform,requested))descriptor.input_modalities=['text','image'];
 }
 return body;
}
