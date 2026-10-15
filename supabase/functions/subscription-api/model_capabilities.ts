import { HttpError } from "./db.ts";

export type Metadata={id:string;display_name?:string;description?:string;reasoning?:boolean;default_reasoning_level?:string;supported_reasoning_levels?:string[];input_modalities?:string[];context_window?:number;max_context_window?:number;max_output_tokens?:number;codex_tool_capabilities?:Record<string,unknown>};
type Fields=Record<string,unknown>;
const object=(value:unknown):Fields=>value && typeof value==="object" && !Array.isArray(value)?value as Fields:{};
const text=(value:unknown,max=8192)=>typeof value==="string"?value.trim().slice(0,max):"";
const positive=(value:unknown)=>typeof value==="number" && Number.isSafeInteger(value) && value>0?value:0;
const list=(value:unknown)=>Array.isArray(value)?value:[];
function level(value:unknown) {
  const valueText=text(value,20).toLowerCase(),normalized=({off:"none",disabled:"none","extra-high":"xhigh",extra_high:"xhigh"} as Record<string,string>)[valueText]??valueText;
  return ["none","minimal","low","medium","high","xhigh","max","ultra"].includes(normalized)?normalized:"";
}
export function completeMetadata(value:Metadata) {
  return typeof value.reasoning==="boolean" && !!value.input_modalities?.length && (value.context_window??0)>0 && (!value.reasoning || !!value.supported_reasoning_levels?.length);
}
export function mediaModel(id:string) {return /^(gpt-image-|dall-e-|sora(?:-|$)|imagen(?:-|$)|veo(?:-|$))/.test(id) || /gemini.*(?:image|video)/.test(id);}

export function modelMetadata(id:string,value:unknown,registry=false):Metadata {
  const entry=object(value),limit=object(entry.limit),modalities=object(entry.modalities);
  const rawLevels=list(entry.supported_reasoning_levels).map(item=>typeof item==="string"?item:object(item).effort);
  const optionLevels=list(entry.reasoning_options).flatMap(item=>text(object(item).type).toLowerCase()==="effort"?list(object(item).values).map(value=>value===null?"none":value):[]);
  const levels=[...new Set((rawLevels.length?rawLevels:optionLevels).map(level).filter(Boolean))];
  const inputs=[...new Set((list(entry.input_modalities).length?list(entry.input_modalities):list(modalities.input)).map(v=>text(v,20).toLowerCase()).filter(v=>["text","image"].includes(v)))];
  const context=positive(entry.context_window)||positive(entry.max_context_window)||positive(entry.inputTokenLimit)||positive(limit.context);
  const metadata:Metadata={id};
  const display=text(entry.display_name)||text(entry.displayName)||text(entry.name);
  if(display && display!==id && !display.startsWith('models/'))metadata.display_name=display;
  const description=text(entry.description);if(description)metadata.description=description;
  if(typeof entry.reasoning==="boolean")metadata.reasoning=entry.reasoning;
  else if(levels.length)metadata.reasoning=registry || levels.length!==1 || levels[0]!=="none";
  if(levels.length){metadata.supported_reasoning_levels=levels;metadata.default_reasoning_level=level(entry.default_reasoning_level)||levels[0];}
  if(inputs.length)metadata.input_modalities=inputs;
  if(context)metadata.context_window=context;
  const maxContext=positive(entry.max_context_window)||(registry?context:0);if(maxContext)metadata.max_context_window=maxContext;
  const output=positive(entry.max_output_tokens)||positive(entry.outputTokenLimit)||positive(limit.output);if(output)metadata.max_output_tokens=output;
  const capabilities:Fields={};
  for(const field of ["service_tiers","supports_search_tool","apply_patch_tool_type","comp_hash","tool_mode","use_responses_lite","multi_agent_reasoning_effort","multi_agent_version"]) {
    if(!Object.hasOwn(entry,field))continue;const value=entry[field];
    if(field==="service_tiers"){
      if(value===null)capabilities[field]=[];
      else if(Array.isArray(value) && value.length<=100 && value.every(v=>v && typeof v==='object' && !Array.isArray(v) && Object.values(v).every(item=>typeof item==='string' && item.length<=8192)))capabilities[field]=value;
    } else if(value===null || (["supports_search_tool","use_responses_lite"].includes(field)?typeof value==="boolean":typeof value==="string" && value.length<=8192))capabilities[field]=value;
  }
  if(Object.keys(capabilities).length)metadata.codex_tool_capabilities=capabilities;
  return metadata;
}

export function extractModelCatalog(value:Record<string,unknown>) {
  if(!Array.isArray(value.data) && !Array.isArray(value.models))throw new HttpError(502,"invalid_upstream_model_catalog");
  const entries=[...list(value.data),...list(value.models)];
  if(entries.length>10000)throw new HttpError(502,"upstream_model_catalog_too_large");
  const metadata:Record<string,Metadata>=Object.create(null);
  for(const item of entries){
    const entry=object(item),id=(text(entry.id,201)||text(entry.slug,201)||text(entry.name,201)).replace(/^models\//,"");
    if(!id || id.length>200 || /[\x00-\x1f\x7f*]/.test(id))throw new HttpError(502,"invalid_upstream_model_catalog");
    metadata[id]=modelMetadata(id,entry);
  }
  return {models:Object.keys(metadata).sort(),metadata};
}

export function mergeMetadata(primary:Metadata,fallback:Metadata):Metadata {
  const merged={...primary};
  for(const [key,value] of Object.entries(fallback))if(merged[key as keyof Metadata]===undefined || (Array.isArray(merged[key as keyof Metadata]) && !(merged[key as keyof Metadata] as unknown[]).length))Object.assign(merged,{[key]:value});
  // A direct default context remains the ceiling unless the upstream specifies a maximum.
  if(primary.context_window && !primary.max_context_window)delete merged.max_context_window;
  return merged;
}

export function modelMetadataSnapshot(value:unknown) {
  const input=object(value),models=object(input.models),synced=text(input.synced_at,65);
  if(!input.models || typeof input.models!=='object' || Array.isArray(input.models) || !['upstream','models.dev'].includes(String(input.source)) || !synced || synced.length>64 || !Number.isFinite(Date.parse(synced)) || Object.keys(models).length>10500 || JSON.stringify(value).length>8*1024*1024)throw new HttpError(400,'invalid_model_metadata_snapshot');
  const normalized:Record<string,Metadata>=Object.create(null);
  for(const [id,raw] of Object.entries(models)) {
    if(!id || id.length>200 || /[\x00-\x1f\x7f*]/.test(id) || object(raw).id!==id)throw new HttpError(400,'invalid_model_metadata_snapshot');
    const metadata=modelMetadata(id,{...object(object(raw).codex_tool_capabilities),...object(raw)});
    if(!completeMetadata(metadata))throw new HttpError(400,'invalid_model_metadata_snapshot');
    normalized[id]=metadata;
  }
  return {source:input.source,synced_at:synced,models:normalized};
}
