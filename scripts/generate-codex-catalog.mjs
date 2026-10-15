import {spawnSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {DEFAULT_PROVIDER_CATALOGS} from '../supabase/functions/sub2api/provider_models.ts';
import {COMPOSITE_DEFAULT_IDS} from '../supabase/functions/sub2api/composite_defaults.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
const models=[...new Set([...Object.values(DEFAULT_PROVIDER_CATALOGS).flat().map(model=>model.id),...Object.values(COMPOSITE_DEFAULT_IDS).flat(),'custom-model'])].sort();
const result=spawnSync(process.env.GO_BINARY??'go',['run','./cmd/export-codex-catalog'],{cwd:root+'backend',input:JSON.stringify(models),encoding:'utf8',maxBuffer:16*1024*1024});
if(result.status!==0)throw Error('Original Codex descriptor export failed: '+(result.stderr||result.error?.message||result.status));
const catalog=JSON.parse(result.stdout);
if(!Array.isArray(catalog.models)||!catalog.models.some(model=>model.slug==='custom-model'))throw Error('Invalid exported Codex descriptors');
// Keep upstream instructions intact while using this project's public branding.
for(const model of catalog.models)if(typeof model.description==='string')model.description=model.description.replaceAll('routed through Sub2API.','routed through sub2api-cloud.');
// Deduplicate instruction bodies without changing their contents.
const instructions=[];
for(const model of catalog.models){const body=model.model_messages?.instructions_template;if(typeof body!=='string')continue;let index=instructions.indexOf(body);if(index<0){index=instructions.length;instructions.push(body);}model.model_messages.instructions_template_ref=index;delete model.model_messages.instructions_template;}
catalog.instructions=instructions;
catalog.omitted_models=models.filter(id=>!catalog.models.some(model=>model.slug===id));
const target=root+'supabase/functions/sub2api/codex_catalog_templates.json',body=JSON.stringify(catalog)+'\n';
if(process.argv.includes('--check')){if(await readFile(target,'utf8')!==body)throw Error('Codex catalog templates differ from the original Go builder');}
else await writeFile(target,body);
console.log(`Original Codex descriptors ${process.argv.includes('--check')?'verified':'exported'}: ${catalog.models.length}`);
