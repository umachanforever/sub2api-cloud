import {spawnSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const result=spawnSync(process.env.GO_BINARY??'go',['run','./cmd/export-provider-catalogs'],{cwd:new URL('backend/',root),encoding:'utf8'});
if(result.status!==0)throw Error('Provider catalog export failed: '+(result.stderr||result.error?.message));
const value=JSON.parse(result.stdout);
for(const platform of ['openai','anthropic','gemini'])if(!Array.isArray(value.providers?.[platform])||!value.providers[platform].length)throw Error('Invalid provider catalog: '+platform);
if(!value.antigravity?.some(model=>model.id==='gemini-4-argon-high'))throw Error('Missing Argon catalog');
for(const [file,body] of [
 ['provider_models.ts','// Model picker metadata from the pinned Sub2API provider catalogs.\nexport const DEFAULT_PROVIDER_CATALOGS:Record<string,Record<string,unknown>[]> = '+JSON.stringify(value.providers,null,2)+';\n'],
 ['antigravity_catalog.ts','// DefaultModels catalog from the pinned upstream Antigravity provider.\nexport const ANTIGRAVITY_MODELS = '+JSON.stringify(value.antigravity,null,2)+';\n'],
]){
 const target=new URL('supabase/functions/sub2api/'+file,root);
 if(process.argv.includes('--check')){if(await readFile(target,'utf8')!==body)throw Error('Provider catalog differs from vendored Go: '+file);}
 else await writeFile(target,body);
}
console.log('Original provider catalogs verified');
