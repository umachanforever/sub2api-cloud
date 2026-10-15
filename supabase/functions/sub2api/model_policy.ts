import { modernCodexModel } from "./codex_models.ts";
import { DEFAULT_PROVIDER_CATALOGS } from "./provider_models.ts";
import { HttpError } from "./db.ts";
export const DEFAULT_PROVIDER_MODELS:Record<string,string[]> = Object.fromEntries(Object.entries(DEFAULT_PROVIDER_CATALOGS).map(([provider,models])=>[provider,models.map(model=>String(model.id))]));
export type ModelAllowlist = {enabled:boolean;models:string[]};

export function modelAllowlist(value: unknown): ModelAllowlist {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400,"invalid_model_allowlist");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(k => !["enabled","models"].includes(k)) || (input.enabled !== undefined && typeof input.enabled !== "boolean") ||
    (input.models !== undefined && (!Array.isArray(input.models) || input.models.length > 500))) throw new HttpError(400,"invalid_model_allowlist");
  const models:string[] = [],seen = new Set<string>();
  for (const item of (input.models ?? []) as unknown[]) {
    if (typeof item !== "string" || item.length > 200 || /[\x00-\x1f\x7f]/.test(item)) throw new HttpError(400,"invalid_model_allowlist");
    const model = item.trim();
    if (!model) continue;
    if (model.replace(/\*$/,"").includes("*")) throw new HttpError(400,"invalid_model_allowlist");
    if (!seen.has(model.toLowerCase())) {seen.add(model.toLowerCase());models.push(model);}
  }
  if (input.enabled === true && !models.length) throw new HttpError(400,"invalid_model_allowlist");
  return {enabled:input.enabled === true,models};
}

const CODEX_ALIASES: Record<string,string> = {
  "gpt-6-astra": "gpt-6-astra",
  "gpt-5.6-sol": "gpt-5.6-sol",
  "gpt-5.6-terra": "gpt-5.6-terra",
  "gpt-5.6-luna": "gpt-5.6-luna",
  "gpt-5.5": "gpt-5.5",
  "gpt-5.5-pro": "gpt-5.5-pro",
  "codex-auto-review": "codex-auto-review",
  "gpt-5.4": "gpt-5.4",
  "gpt-5.4-mini": "gpt-5.4-mini",
  "gpt-5.4-none": "gpt-5.4",
  "gpt-5.4-low": "gpt-5.4",
  "gpt-5.4-medium": "gpt-5.4",
  "gpt-5.4-high": "gpt-5.4",
  "gpt-5.4-xhigh": "gpt-5.4",
  "gpt-5.4-chat-latest": "gpt-5.4",
  "gpt-5.3": "gpt-5.3-codex",
  "gpt-5.3-none": "gpt-5.3-codex",
  "gpt-5.3-low": "gpt-5.3-codex",
  "gpt-5.3-medium": "gpt-5.3-codex",
  "gpt-5.3-high": "gpt-5.3-codex",
  "gpt-5.3-xhigh": "gpt-5.3-codex",
  "gpt-5.3-codex": "gpt-5.3-codex",
  "gpt-5.3-codex-spark": "gpt-5.3-codex-spark",
  "gpt-5.3-codex-low": "gpt-5.3-codex",
  "gpt-5.3-codex-medium": "gpt-5.3-codex",
  "gpt-5.3-codex-high": "gpt-5.3-codex",
  "gpt-5.3-codex-xhigh": "gpt-5.3-codex",
  "gpt-5.2": "gpt-5.2",
  "gpt-5.2-none": "gpt-5.2",
  "gpt-5.2-low": "gpt-5.2",
  "gpt-5.2-medium": "gpt-5.2",
  "gpt-5.2-high": "gpt-5.2",
  "gpt-5.2-xhigh": "gpt-5.2",
  "gpt-5": "gpt-5.4",
  "gpt-5-mini": "gpt-5.4",
  "gpt-5-nano": "gpt-5.4",
  "gpt-5.1": "gpt-5.4",
  "gpt-5.1-codex": "gpt-5.3-codex",
  "gpt-5.1-codex-max": "gpt-5.3-codex",
  "gpt-5.1-codex-mini": "gpt-5.3-codex",
  "gpt-5.2-codex": "gpt-5.2",
  "codex-mini-latest": "gpt-5.3-codex",
  "gpt-5-codex": "gpt-5.3-codex"
};
const CLAUDE_ALIASES: Record<string,string> = {
  "claude-sonnet-4-5":"claude-sonnet-4-5-20250929", "claude-opus-4-5":"claude-opus-4-5-20251101", "claude-haiku-4-5":"claude-haiku-4-5-20251001",
};
function claudeModel(model:string) {
  const base = model.endsWith("-thinking") ? model.slice(0,-9) : model;
  return CLAUDE_ALIASES[base] ?? base;
}
function compatModel(model:string) {
  const modern = modernCodexModel(model);
  if (modern) return modern.id;
  const segment = model.split("/").at(-1)!.trim();
  const suffix = segment.toLowerCase().split(/[-_ ]/).filter(Boolean).at(-1);
  if (!/^gpt-/i.test(segment) || !["none","minimal","low","medium","high","xhigh","extrahigh"].includes(suffix ?? "")) return model;
  let canonical = segment.toLowerCase().replace(/[_\s]+/g,"-").replace(/-+/g,"-").replace(/^gpt5/,"gpt-5");
  for (const [from,to] of [["gpt-5.4mini","gpt-5.4-mini"],["gpt-5.4nano","gpt-5.4-nano"],["gpt-5.3-codexspark","gpt-5.3-codex-spark"],["gpt-5.3codexspark","gpt-5.3-codex-spark"],["gpt-5.3codex","gpt-5.3-codex"]]) canonical=canonical.replaceAll(from,to);
  const mapped = CODEX_ALIASES[canonical] ?? (canonical.endsWith("-openai-compact") ? CODEX_ALIASES[canonical.slice(0,-15)] : undefined);
  if (mapped) return mapped;
  if (canonical === "gpt-6") return "gpt-6-sol";
  if (canonical === "gpt-6-astra") return "gpt-6-astra";
  for (const family of ["gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna"]) if (canonical.includes(family)) return family;
  if (canonical === "gpt-5.6" || /^gpt-5\.6-(?:max|none|minimal|low|medium|high|xhigh|\d{4}-\d{2}-\d{2})$/.test(canonical)) return "gpt-5.6-sol";
  if (!canonical.startsWith("gpt-5.6-")) {
    for (const family of ["gpt-5.5-pro","gpt-5.5","gpt-5.4-mini","gpt-5.4-nano","gpt-5.4","gpt-5.2","gpt-5.3-codex-spark","gpt-5.3-codex"]) if (canonical.includes(family)) return family;
    if (canonical.includes("gpt-5.3") || canonical.includes("codex")) return "gpt-5.3-codex";
    if (canonical.includes("gpt-5")) return "gpt-5.4";
  }
  return segment;
}
export function modelCandidates(model:string): string[] {
  model=model.trim();
  return [...new Set([model,model.startsWith("models/")?model.slice(7):model,claudeModel(model),compatModel(model)].map(m=>m.trim().toLowerCase()).filter(Boolean))];
}
export function allowsModel(config:ModelAllowlist|undefined,model:string) {
  if (!config?.enabled || !model.trim()) return true;
  const candidates=modelCandidates(model);
  return config.models.some(entry=>{entry=entry.trim().toLowerCase();return !!entry && candidates.some(candidate=>entry.endsWith("*")?candidate.startsWith(entry.slice(0,-1)):candidate===entry);});
}
export function allowlistedModels(config:ModelAllowlist|undefined,source:string[]):string[] {
  if (!config?.enabled) return source;
  const patterns=source.map(m=>m.trim()).filter(Boolean),result:string[]=[],seen=new Set<string>();
  const add=(model:string)=>{const key=model.toLowerCase();if(!seen.has(key)){seen.add(key);result.push(model);}};
  for(let entry of config.models) {
    entry=entry.trim();if(!entry)continue;
    if(entry.endsWith("*")) {for(const pattern of patterns)if(pattern.toLowerCase().startsWith(entry.slice(0,-1).toLowerCase()))add(pattern);}
    else if(patterns.some(pattern=>pattern.toLowerCase()===entry.toLowerCase() || pattern.endsWith("*") && entry.toLowerCase().startsWith(pattern.slice(0,-1).toLowerCase()) || claudeModel(entry)!==entry && pattern.toLowerCase()===claudeModel(entry).toLowerCase()))add(entry);
  }
  return result;
}
export function filterModelCatalog(config:ModelAllowlist|undefined,value:Record<string,any>,single=false) {
  if(!config?.enabled)return value;
  if(single) {if(!allowsModel(config,value.id ?? value.name ?? ""))throw new HttpError(404,"model_not_found");return value;}
  if(Array.isArray(value.models)) return {...value,models:value.models.filter((model:Record<string,unknown>)=>allowsModel(config,String(model.name??model.slug??"")))};
  const ids=allowlistedModels(config,value.data.map((model:Record<string,unknown>)=>String(model.id)));
  const entries=ids.map(id=>{const found=value.data.find((model:Record<string,unknown>)=>String(model.id).toLowerCase()===id.toLowerCase());return found?{...found,id}:{id,object:"model",created:0,owned_by:"gateway"};});
  return {...value,data:entries};
}
