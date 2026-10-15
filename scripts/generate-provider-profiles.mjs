import {spawnSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const result=spawnSync(process.env.GO_BINARY??'go',['run','./cmd/export-provider-profiles'],{cwd:new URL('backend/',root),encoding:'utf8'});
if(result.status!==0)throw Error('Original provider profile export failed: '+(result.stderr||result.error?.message));
const profiles=JSON.parse(result.stdout);
for(const platform of ['kimi','zhipu','deepseek','minimax','opencode_go','command_code','cline']){
  const profile=profiles[platform];
  if(profile?.Platform!==platform||!profile.Modes?.[profile.DefaultMode]?.BaseURLs?.chat_completions)throw Error('Invalid provider profile: '+platform);
}
const target=new URL('supabase/functions/sub2api/provider_profiles.json',root),body=JSON.stringify(profiles)+'\n';
if(process.argv.includes('--check')){
  if(await readFile(target,'utf8')!==body)throw Error('Provider profiles differ from original Go');
}else await writeFile(target,body);
console.log('Original multi-protocol provider profiles verified');
