import {modelMetadata} from './model_capabilities.ts';
import {mappedTarget} from './model_mapping.ts';
type Entry=Record<string,any>;
const capabilityFields=['service_tiers','supports_search_tool','apply_patch_tool_type','comp_hash','tool_mode','use_responses_lite','multi_agent_reasoning_effort','multi_agent_version'];
const descriptions:Record<string,string>={none:"Use the model's default behavior without configurable reasoning",minimal:'Minimal reasoning for the fastest responses',low:'Fast responses with lighter reasoning',medium:'Balanced reasoning for most coding tasks',high:'Greater reasoning depth for coding and agent tasks',xhigh:'Extra-high reasoning depth for difficult tasks',max:'Maximum reasoning depth for complex tasks',ultra:'Maximum reasoning with automatic task delegation'};
function completeMissing(defaults:Entry,provided:Entry):Entry{
 const result={...defaults,...provided};
 for(const key of Object.keys(defaults)){
  const value=provided[key],fallback=defaults[key];
  if(value===undefined||value===null)result[key]=fallback;
  else if(value&&typeof value==='object'&&!Array.isArray(value)&&fallback&&typeof fallback==='object'&&!Array.isArray(fallback))result[key]=completeMissing(fallback,value);
 }
 return result;
}
// Synced account metadata fills missing live fields before local descriptor defaults.
// Explicit live nullable tool capabilities remain authoritative, including false/null.
export function completePinnedMetadata(descriptor:Entry,entry:Entry,snapshot:unknown,mapping:Record<string,string>):Entry{
 const slug=String(entry.slug),target=mappedTarget(mapping,slug,'openai')??slug;
 const raw=(snapshot as {models?:Record<string,Entry>}|undefined)?.models?.[target];
 const provided={...entry};
 if(raw&&typeof raw==='object'&&!Array.isArray(raw)){
  const metadata=modelMetadata(target,{...raw.codex_tool_capabilities,...raw});
  const synced:Entry={};
  if(target===slug){if(metadata.display_name)synced.display_name=metadata.display_name;if(metadata.description)synced.description=metadata.description;}
  if(metadata.reasoning!==undefined){
   const levels=metadata.reasoning?(metadata.supported_reasoning_levels??[]):['none'];
   synced.default_reasoning_level=levels.includes(metadata.default_reasoning_level??'')?metadata.default_reasoning_level:levels[0]??null;
   synced.supported_reasoning_levels=levels.map(effort=>({effort,description:descriptions[effort]??effort}));
  }
  if(metadata.input_modalities?.length)synced.input_modalities=metadata.input_modalities;
  if(metadata.context_window){synced.context_window=Math.min(metadata.context_window,metadata.max_context_window??metadata.context_window);synced.max_context_window=metadata.max_context_window??metadata.context_window;}
  for(const [key,value] of Object.entries(synced))if(provided[key]===undefined||provided[key]===null)provided[key]=value;
  for(const [key,value] of Object.entries(metadata.codex_tool_capabilities??{}))if(!Object.hasOwn(provided,key))provided[key]=value;
 }
 const result=completeMissing(descriptor,provided);
 for(const field of capabilityFields)if(Object.hasOwn(provided,field))result[field]=field==='service_tiers'&&provided[field]===null?[]:provided[field];
 // API-key providers use full Responses for the original targeted model set.
 if(['gpt-6.1-sol','gpt-6-astra','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna'].includes(target)&&result.use_responses_lite===true)result.use_responses_lite=false;
 return result;
}
