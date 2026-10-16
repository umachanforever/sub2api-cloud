import {codexCatalogModelAllowed} from './codex_catalog.ts';
import {allowsModel,allowlistedModels,type ModelAllowlist} from './model_policy.ts';
type Entry=Record<string,any>;
// Routing wildcards and automatic modes are not ordinary Codex picker entries.
// Automatic modes require exact group opt-in, even when a wildcard admits them.
export function applyCodexCatalogPolicy(body:Entry,allowlist?:ModelAllowlist,ordered=false):Entry{
 const selected=new Set(allowlist?.enabled?allowlist.models.map(id=>id.trim()):[]);
 const models=(body.models as Entry[]).flatMap(entry=>{
  const slug=typeof entry?.slug==='string'?entry.slug.trim():'';
  if(!slug)return allowlist?.enabled?[]:[entry];
  if(slug.includes('*')||!codexCatalogModelAllowed(slug)||!allowsModel(allowlist,slug))return [];
  if(slug.startsWith('codex-auto-'))return selected.has(slug)?[{...entry,visibility:'list'}]:[];
  return [entry];
 });
 if(!ordered||!allowlist?.enabled)return {...body,models};
 const byId=new Map(models.map(entry=>[entry.slug,entry]));
 return {...body,models:allowlistedModels(allowlist,models.map(entry=>entry.slug)).flatMap(id=>byId.has(id)?[byId.get(id)!]:[])};
}
