import {spawnSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const result=spawnSync(process.env.GO_BINARY??'go',['run','./cmd/export-antigravity-mapping'],{cwd:new URL('backend/',root),encoding:'utf8'});
if(result.status!==0)throw Error('Original Antigravity mapping export failed: '+(result.stderr||result.error?.message));
const value=JSON.parse(result.stdout);
if(!value.defaults?.['gemini-pro-agent']||!value.supplemental?.['gemini-3-flash'])throw Error('Invalid original Antigravity mappings');
const target=new URL('supabase/functions/sub2api/antigravity_mapping.json',root),body=JSON.stringify(value)+'\n';
if(process.argv.includes('--check')){if(await readFile(target,'utf8')!==body)throw Error('Antigravity mappings differ from original Go');}
else await writeFile(target,body);
console.log('Original Antigravity mapping rules verified');
