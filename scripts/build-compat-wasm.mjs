import {spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';

const root=new URL('../',import.meta.url),backend=new URL('backend/',root),target=new URL('supabase/functions/sub2api/compat/',root),go=process.env.GO_BINARY??'go';
const scratch=await mkdtemp(join(tmpdir(),'sub2api-compat-'));
try{
  for(const [command,file] of [['export-gemini-compat','gemini_generated.go'],['export-codex-metadata','codex_metadata_generated.go'],['export-fast-policy','fast_policy_generated.go']]){
    const extracted=spawnSync(go,['run','./cmd/'+command],{cwd:backend,encoding:'utf8'});
    if(extracted.status!==0)throw Error('Original source extraction failed: '+(extracted.stderr||extracted.error?.message));
    const generated=new URL('cmd/compat-wasm/'+file,backend);
    if(process.argv.includes('--check')){
      if(!(await readFile(generated)).equals(Buffer.from(extracted.stdout)))throw Error('Original source differs: '+file);
    }else await writeFile(generated,extracted.stdout);
  }
  const build=spawnSync(go,['build','-trimpath','-buildvcs=false','-ldflags=-s -w -buildid=','-o',join(scratch,'compat.wasm'),'./cmd/compat-wasm'],{cwd:backend,encoding:'utf8',env:{...process.env,GOOS:'js',GOARCH:'wasm',CGO_ENABLED:'0'}});
  if(build.status!==0)throw Error('Original protocol WASM build failed: '+(build.stderr||build.error?.message));
  const info=spawnSync(go,['env','GOROOT'],{cwd:backend,encoding:'utf8'});
  if(info.status!==0)throw Error('Cannot locate matching Go runtime');
  const sdk=info.stdout.trim();
  const dependencies=spawnSync(go,['list','-deps','-f','{{if .Module}}{{.Module.Path}}|{{.Module.Version}}|{{.Module.Dir}}{{end}}','./cmd/compat-wasm'],{cwd:backend,encoding:'utf8',env:{...process.env,GOOS:'js',GOARCH:'wasm',CGO_ENABLED:'0'}});
  if(dependencies.status!==0)throw Error('Cannot inspect protocol converter licenses');
  const modules=[...new Set(dependencies.stdout.trim().split('\n').filter(line=>line.includes('|')&&!line.startsWith('github.com/Wei-Shaw/sub2api|')))].sort();
  const licenses=[];
  for(const module of modules){
    const [name,version,path]=module.split('|');
    const license=await readFile(join(path,'LICENSE'),'utf8');
    let patents='';try{patents=await readFile(join(path,'PATENTS'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
    licenses.push(`${name} ${version}\n\n${license}${patents?'\n'+patents:''}`);
  }
  const artifacts={
    'compat.wasm.gz':gzipSync(await readFile(join(scratch,'compat.wasm')),{level:9}),
    'wasm_exec.js':await readFile(join(sdk,'lib/wasm/wasm_exec.js')),
    'GO_LICENSE.txt':await readFile(join(sdk,'LICENSE')),
    'THIRD_PARTY_LICENSES.txt':Buffer.from(licenses.join('\n\n---\n\n').trimEnd()+'\n'),
  };
  if(!process.argv.includes('--check'))await mkdir(target,{recursive:true});
  for(const [name,body] of Object.entries(artifacts)){
    const path=new URL(name,target);
    if(process.argv.includes('--check')){
      const committed=await readFile(path);
      // Node releases can produce different gzip bytes for identical WASM.
      const matches=name==='compat.wasm.gz'
        ?gunzipSync(committed).equals(gunzipSync(body))
        :committed.equals(body);
      if(!matches)throw Error('Original protocol WASM artifact differs: '+name);
    }
    else await writeFile(path,body);
  }
  console.log('Original Go protocol converters and runtime verified');
}finally{await rm(scratch,{recursive:true,force:true});}
