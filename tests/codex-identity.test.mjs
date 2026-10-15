import test from 'node:test';
import assert from 'node:assert/strict';
import { currentCodexIdentity, resolveCodexIdentity } from '../supabase/functions/subscription-api/codex_identity.ts';
import { Database } from '../supabase/functions/subscription-api/db.ts';
import { buildHeaders } from '../supabase/functions/subscription-api/gateway.ts';

test('Codex version precedence and UA identity match the Go resolver',()=>{
 const settings={version:'0.162.1',synced:'0.161.0',user_agent:'CODEX_VSCODE/0.144.0 (Mac OS X; arm64) terminal'};
 const identity=resolveCodexIdentity(settings);
 assert.equal(identity.version,'0.162.1');assert.equal(identity.originator,'codex_vscode');
 assert.equal(identity.userAgent,'codex_vscode/0.162.1 (Mac OS X; arm64) terminal');
 assert.equal(resolveCodexIdentity({...settings,version:''}).version,'0.161.0');
 assert.equal(resolveCodexIdentity({...settings,version:'invalid',synced:'0.100.0'}).version,'0.146.0');
 const account=resolveCodexIdentity(settings,{access_token:'secret',user_agent:'codex-tui/0.145.0 (Linux)'});
 assert.equal(account.userAgent,'codex-tui/0.162.1 (Linux)');
 for(const user_agent of ['codex-tui/0.144.0\r\nx-secret: a','codex-tui/0.144.0\x00','evil/0.144.0'])assert.equal(resolveCodexIdentity({user_agent}).originator,'codex-tui');
 const headers=buildHeaders({access_token:'secret'},identity);
 assert.equal(headers.get('version'),identity.version);assert.equal(headers.get('user-agent'),identity.userAgent);assert.equal(headers.get('originator'),identity.originator);
});

test('cloud synchronizes official stable versions once and persists the result',async()=>{
 let releases=0,saves=0;
 const db=new Database({url:'https://db.example',serviceKey:'secret',encryptionKey:'',adminIds:[],dataModel:'native'},async(url,init)=>{
  if(new URL(url).hostname==='api.github.com'){releases++;return Response.json({tag_name:'rust-v0.162.1',draft:false,prerelease:false});}
  saves++;assert.equal(JSON.parse(init.body).p_version,'0.162.1');return Response.json({version:'0.162.1',synced_at:new Date().toISOString()});
 });
 const account={codex_settings:{auto_sync:'true'}};
 const results=await Promise.all(Array.from({length:3},()=>currentCodexIdentity(db,account,{access_token:'secret'})));
 for(const result of results)assert.equal(result.version,'0.162.1');
 assert.equal(releases,1);assert.equal(saves,1);
 assert.equal((await currentCodexIdentity(db,{codex_settings:{version:'0.160.0',auto_sync:'false'}},{access_token:'secret'})).version,'0.160.0');
 assert.equal(releases,1);
});

test('failed or nonstable sync keeps the last known version',async()=>{
 for(const release of [{tag_name:'rust-v0.163.0-alpha.1',draft:false,prerelease:true},{tag_name:'other-v9.0.0',draft:false,prerelease:false},null]){
  const db=new Database({url:'https://db.example',serviceKey:'secret',encryptionKey:'',adminIds:[],dataModel:'native'},async()=>{if(!release)throw Error('offline');return Response.json(release);});
  assert.equal((await currentCodexIdentity(db,{codex_settings:{synced:'0.160.0'}},{access_token:'secret'})).version,'0.160.0');
 }
});

test('cloud model discovery uses the same current version in catalog query and identity headers',async()=>{
 const {createHandler}=await import('../supabase/functions/subscription-api/app.ts');
 let upstream=0;
 const config={url:'https://db.example',serviceKey:'secret',encryptionKey:'',adminIds:[],dataModel:'native'};
 const app=createHandler(config,async(url,init)=>{
  const parsed=new URL(url);
  if(parsed.pathname.endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'22222222-2222-4222-8222-222222222222',account:{id:'1',credential_storage:'vault',credentials:{access_token:'token'},credential_version:1,platform:'openai',type:'oauth',codex_settings:{synced:'0.162.1',synced_at:new Date().toISOString()}}});
  if(parsed.pathname.includes('/rest/v1/rpc/'))return Response.json(true);
  assert.equal(parsed.hostname,'chatgpt.com');assert.equal(parsed.searchParams.get('client_version'),'0.162.1');
  const headers=new Headers(init.headers);assert.equal(headers.get('version'),'0.162.1');assert.match(headers.get('user-agent'),/^codex-tui\/0\.162\.1 /);
  upstream++;return Response.json({models:[{slug:'gpt-6.1-sol'}]});
 });
 const response=await app(new Request('https://gateway/v1/models',{headers:{authorization:'Bearer sk-test'}}));
 assert.equal(response.status,200);assert.equal(upstream,1);
 assert.equal((await response.json()).data[0].id,'gpt-6.1-sol');
});


test('cloud release fallback excludes other components and prereleases and selects the highest stable version', async () => {
 for (const latest of [null, {tag_name:'rusty-v8-v9.0.0',draft:false,prerelease:false}]) {
  const paths=[];
  const db=new Database({url:'https://db.example',serviceKey:'secret',encryptionKey:'',adminIds:[],dataModel:'native'},async(url,init)=>{
   const parsed=new URL(url);
   if(parsed.hostname==='api.github.com') {
    paths.push(parsed.pathname+parsed.search);
    assert.equal(init.redirect,'error');
    if(parsed.pathname.endsWith('/latest')) return latest ? Response.json(latest) : new Response(null,{status:503});
    return Response.json([
     {tag_name:'rust-v0.99.9',draft:false,prerelease:false},
     {tag_name:'rust-v0.163.0',draft:false,prerelease:false},
     {tag_name:'rust-v0.164.0-alpha.1',draft:false,prerelease:true},
     {tag_name:'rust-v0.200.0',draft:true,prerelease:false},
     {tag_name:'other-v9.0.0',draft:false,prerelease:false},
     {tag_name:'rust-v0.162.1',draft:false,prerelease:false},
    ]);
   }
   assert.equal(JSON.parse(init.body).p_version,'0.163.0');
   return Response.json({version:'0.163.0',synced_at:new Date().toISOString()});
  });
  assert.equal((await currentCodexIdentity(db,{codex_settings:{synced:'0.162.1'}},{access_token:'secret'})).version,'0.163.0');
  assert.deepEqual(paths,['/repos/openai/codex/releases/latest','/repos/openai/codex/releases?per_page=30']);
 }
});


test('scheduled synchronization refreshes a recent identity without waiting for traffic', async () => {
 let releases=0;
 const db=new Database({url:'https://db.test',serviceKey:'secret',encryptionKey:'',adminIds:[],dataModel:'native'},async url=>{
  if(new URL(url).hostname==='api.github.com'){releases++;return Response.json({tag_name:'rust-v0.163.0',draft:false,prerelease:false});}
  return Response.json({version:'0.163.0',synced_at:new Date().toISOString()});
 });
 const account={codex_settings:{synced:'0.162.1',synced_at:new Date().toISOString()}};
 assert.equal((await currentCodexIdentity(db,account,{access_token:''})).version,'0.162.1');
 assert.equal(releases,0);
 for(let index=0;index<2;index++)assert.equal((await currentCodexIdentity(db,account,{access_token:''},true)).version,'0.163.0');
 assert.equal(releases,2);
});
