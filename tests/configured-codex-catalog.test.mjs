import test from 'node:test';
import assert from 'node:assert/strict';
import {configuredCodexCatalog} from '../supabase/functions/sub2api/configured_codex_catalog.ts';
import {createHandler} from './handler.mjs';
const source=(mapping,passthrough=false)=>({platform:'openai',mapping,passthrough});
test('configured catalogs merge every group mapping in sorted order and preserve live metadata',()=>{
 const live={slug:'live',private_extension:{keep:true}};
 const result=configuredCodexCatalog({models:[live],extension:42},{sources:[source({z:'target',live:'different','gpt-image-1':'image'}),source({a:'target','pattern*':'target','codex-auto-review':'target'})]});
 assert.deepEqual(result.models.map(m=>m.slug),['live','a','z']);
 assert.equal(result.extension,42);assert.equal(result.models[0],live);
 assert.ok(result.models[1].model_messages.instructions_template.length>1000);
});
test('unmapped and passthrough group members supplement a partial mapping catalog only',()=>{
 for(const member of [source({}),source({alias:'target'},true)]){
  const result=configuredCodexCatalog({models:[]},{sources:[source({custom:'target'}),member]});
  assert.ok(result.models.some(m=>m.slug==='custom'));assert.ok(result.models.some(m=>m.slug==='gpt-6.1-sol'));
 }
 assert.deepEqual(configuredCodexCatalog({models:[]},{sources:[source({})]}).models,[]);
});
test('selected exact names resolve wildcard mappings and automatic modes still require exact opt-in',()=>{
 const sources={sources:[source({'public-*':'target','codex-auto-*':'target','gpt-image-1':'target'})]};
 const selected={enabled:true,models:['public-name','codex-auto-review','gpt-image-1']};
 const models=configuredCodexCatalog({models:[]},sources,selected).models;
 assert.deepEqual(models.map(m=>m.slug),['codex-auto-review','public-name']);
 assert.equal(models[0].visibility,'list');
 assert.deepEqual(configuredCodexCatalog({models:[]},sources,{enabled:true,models:['codex-auto-*']}).models,[]);
});
for(const type of ['oauth','apikey'])test(type+' scheduled manifests include other group aliases, invalidate ETags and leave ordinary catalogs unchanged',async()=>{
 const config={url:'https://db.invalid',serviceKey:'service',encryptionKey:'',adminIds:[],dataModel:'native'};
 let sources={sources:[source({'group-alias':'missing-live-target'})]};
 const finishes=[];
 const handler=createHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',configured_model_sources:sources,account:{id:'1',platform:'openai',type,credential_storage:'vault',credentials:type==='oauth'?{access_token:'synthetic'}:{api_key:'synthetic'},credential_version:1,codex_settings:{auto_sync:'false'}}});
  if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json(null);}
  return Response.json(type==='oauth'?{models:[{slug:'live',instructions:'keep'}]}:{data:[{id:'live',instructions:'keep'}]});
 });
 const get=(path,tag)=>new Request('https://gateway'+path,{headers:{authorization:'Bearer sk-client',...(tag?{'if-none-match':tag}:{})}});
 for(const path of ['/backend-api/codex/models','/v1/models?client_version=0.150.0']){
  const first=await handler(get(path));assert.equal(first.status,200);
  assert.deepEqual((await first.json()).models.map(m=>m.slug),['live','group-alias']);
  const tag=first.headers.get('etag');assert.equal((await handler(get(path,tag))).status,304);
 }
 const prior=await handler(get('/backend-api/codex/models'));
 sources={sources:[source({'new-alias':'target'})]};
 const changed=await handler(get('/backend-api/codex/models',prior.headers.get('etag')));assert.equal(changed.status,200);assert.ok((await changed.json()).models.some(m=>m.slug==='new-alias'));
 const ordinary=await handler(get('/v1/models'));assert.equal(ordinary.status,200);assert.deepEqual((await ordinary.json()).data.map(m=>m.id),['live']);
 assert.ok(finishes.every(f=>f.p_status===200&&f.p_input_tokens===null));
});
test('OAuth mapping aliases absent from the live manifest receive full original descriptors',async()=>{
 const {mappedCatalog}=await import('../supabase/functions/sub2api/model_mapping.ts');
 const manifest=mappedCatalog({models:[{slug:'live',instructions:'keep'}]},{mapping:{'custom-alias':'target-not-discovered'},include_upstream:true},'openai');
 const alias=manifest.models.find(model=>model.slug==='custom-alias');
 assert.equal(alias.display_name,'custom-alias');assert.ok(alias.model_messages.instructions_template.length>1000);
 assert.equal(manifest.models[0].instructions,'keep');
});

test('scheduled OAuth Codex discovery preserves slugless raw entries and filters them with an allowlist',async()=>{
 const raw=[null,7,'opaque',[],{extension:true},{slug:42},{slug:'live',extension:'keep'}];
 let allowlist;
 const config={url:'https://db.invalid',serviceKey:'service',encryptionKey:'',adminIds:[],dataModel:'native'};
 const handler=createHandler(config,async(url)=>{
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',model_allowlist:allowlist,configured_model_sources:{sources:[source({'other':'target'})]},account:{id:'1',platform:'openai',type:'oauth',credential_storage:'vault',credentials:{access_token:'synthetic'},credential_version:1}});
  if(String(url).endsWith('/s2a_personal_finish'))return Response.json(null);
  return Response.json({models:raw});
 });
 const get=path=>new Request('https://gateway'+path,{headers:{authorization:'Bearer sk-client'}});
 for(const path of ['/backend-api/codex/models','/v1/models?client_version=0.150.0']){
  const response=await handler(get(path));assert.equal(response.status,200);
  assert.deepEqual((await response.json()).models.slice(0,raw.length),raw);
 }
 allowlist={enabled:true,models:['live']};
 const selected=await handler(get('/backend-api/codex/models'));assert.equal(selected.status,200);
 assert.deepEqual((await selected.json()).models,[raw.at(-1)]);
 allowlist=undefined;
 assert.equal((await handler(get('/v1/models'))).status,502);
});
