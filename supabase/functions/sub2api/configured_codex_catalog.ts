import {codexCatalogDescriptor} from './codex_catalog.ts';
import {applyCodexCatalogPolicy} from './codex_catalog_policy.ts';
import {DEFAULT_PROVIDER_CATALOGS} from './provider_models.ts';
import {mappedTarget} from './model_mapping.ts';
import type {ModelAllowlist} from './model_policy.ts';
export type ConfiguredModelSources={sources:{platform:string;passthrough:boolean;mapping:Record<string,string>}[]};
// Group mappings supplement the selected account's manifest, matching Go's
// openAIConfiguredCodexModelIDsForGroup and mergeConfiguredCodexModelsManifest.
export function configuredCodexCatalog(body:Record<string,any>,input:ConfiguredModelSources|undefined,allowlist?:ModelAllowlist):Record<string,any>{
 if(!input)return applyCodexCatalogPolicy(body,allowlist);
 const accounts=input.sources.filter(source=>source.platform==='openai');
 const configured=new Set(accounts.flatMap(source=>Object.keys(source.mapping)).map(id=>id.trim()).filter(id=>id&&!id.includes('*')));
 if(configured.size&&accounts.some(source=>source.passthrough||!Object.keys(source.mapping).length))for(const entry of DEFAULT_PROVIDER_CATALOGS.openai)configured.add(String(entry.id));
 if(allowlist?.enabled)for(const id of allowlist.models.map(id=>id.trim())){
  if(id&&!id.includes('*')&&accounts.some(source=>mappedTarget(source.mapping,id,'openai')?.trim()))configured.add(id);
 }
 const seen=new Set(body.models.map((entry:Record<string,any>)=>entry.slug?.trim()));
 const models=[...body.models];
 for(const id of [...configured].sort()){
  if(seen.has(id))continue;
  const descriptor=codexCatalogDescriptor(id);
  if(descriptor){models.push(descriptor);seen.add(id);}
 }
 return applyCodexCatalogPolicy({...body,models},allowlist);
}
