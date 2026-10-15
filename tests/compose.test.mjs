import assert from 'node:assert/strict';
import {copyFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const available=spawnSync('docker',['compose','version'],{timeout:10000}).status===0;
test('Compose resolves fresh-checkout services before management secrets are provisioned',{skip:!available},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'s2a-compose-'));
 try{
  await copyFile(new URL('../compose.yaml',import.meta.url),join(directory,'compose.yaml'));
  const result=spawnSync('docker',['compose','-p','sub2api-supabase-check','-f',join(directory,'compose.yaml'),'config','--services'],{
   encoding:'utf8',timeout:10000,
   env:{...process.env,SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_build_placeholder'},
  });
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n').sort(),['console','management','redis']);
 }finally{await rm(directory,{recursive:true,force:true});}
});
