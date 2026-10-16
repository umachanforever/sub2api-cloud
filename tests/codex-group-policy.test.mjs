import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from './handler.mjs';
const config={url:'https://db.invalid',serviceKey:'service',encryptionKey:'',adminIds:[],dataModel:'native'};
const entries=[{slug:'gpt-6-sol',instructions:'keep'},{slug:'codex-auto-review',visibility:'hide',custom:'preserved'},{slug:'gpt-image-1'},{slug:'routing*'}];
const account={id:'1',platform:'openai',type:'oauth',credential_storage:'vault',credentials:{access_token:'synthetic'},credential_version:1,codex_settings:{auto_sync:'false'}};
const get=(path,etag)=>new Request('https://gateway'+path,{headers:{authorization:'Bearer sk-client',...(etag?{'if-none-match':etag}:{})}});
function app(mode,policy){return createHandler(config,async(url)=>{
 if(String(url).endsWith('/s2a_personal_acquire')){
  const model_allowlist=policy();
  if(mode==='pinned')return Response.json({pinned_catalog:{accounts:[account],model_allowlist}});
  if(mode==='composite')return Response.json({composite_catalog:{sources:[{platform:'openai',passthrough:false,mapping:Object.fromEntries(entries.map(entry=>[entry.slug,entry.slug]))}],routes:[]},model_allowlist});
  if(mode==='anthropic')return Response.json({anthropic_catalog:entries.map(entry=>entry.slug),model_allowlist});
  return Response.json({lease_id:'lease',account,model_allowlist});
 }
 if(String(url).endsWith('/s2a_personal_finish'))return Response.json(null);
 return Response.json({models:entries});
});}
for(const mode of ['pinned','scheduled','composite','anthropic']){
 test(mode+' Codex catalog requires exact automatic-mode opt-in and removes media and routing patterns',async()=>{
  let policy;
  const handler=app(mode,()=>policy);
  for(const selected of [undefined,{enabled:true,models:['*']},{enabled:true,models:['codex-auto-*','gpt-*']}]){
   policy=selected;const response=await handler(get('/backend-api/codex/models'));assert.equal(response.status,200);
   const ids=(await response.json()).models.map(model=>model.slug);
   assert.ok(ids.includes('gpt-6-sol'));assert.ok(ids.every(id=>!id.startsWith('codex-auto-')&&!id.includes('*')&&id!=='gpt-image-1'));
   if(mode!=='anthropic')assert.deepEqual(ids,['gpt-6-sol']);
  }
  policy={enabled:true,models:['codex-auto-review','gpt-6-sol']};
  const response=await handler(get('/backend-api/codex/models'));assert.equal(response.status,200);const models=(await response.json()).models;
  assert.deepEqual(new Set(models.map(model=>model.slug)),new Set(['codex-auto-review','gpt-6-sol']));
  assert.equal(models.find(model=>model.slug==='codex-auto-review').visibility,'list');
  if(mode==='pinned')assert.deepEqual(models.map(model=>model.slug),policy.models);
  if(['pinned','scheduled'].includes(mode))assert.equal(models.find(model=>model.slug==='codex-auto-review').custom,'preserved');
 });
}
test('Codex policy changes invalidate final ETags and leave ordinary media discovery available',async()=>{
 let policy={enabled:true,models:['*']};const handler=app('pinned',()=>policy);
 const first=await handler(get('/backend-api/codex/models'));assert.equal(first.status,200);const tag=first.headers.get('etag');
 assert.equal((await handler(get('/backend-api/codex/models',tag))).status,304);
 policy={enabled:true,models:['codex-auto-review','gpt-6-sol']};
 const changed=await handler(get('/backend-api/codex/models',tag));assert.equal(changed.status,200);assert.notEqual(changed.headers.get('etag'),tag);
 policy=undefined;const ordinary=await handler(get('/v1/models'));assert.equal(ordinary.status,200);const ids=(await ordinary.json()).data.map(model=>model.id);assert.ok(ids.includes('gpt-image-1'));assert.ok(ids.includes('codex-auto-review'));
});

test('pinned aliases cannot expose an automatic target without its exact group opt-in',async()=>{
 let policy={enabled:true,models:['public-review']};
 const source={...account,credentials:{...account.credentials,model_mapping:{'public-review':'codex-auto-review'}}};
 const handler=createHandler(config,async(url)=>{
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({pinned_catalog:{accounts:[source],model_allowlist:policy}});
  return Response.json({models:[{slug:'codex-auto-review',visibility:'hide'}]});
 });
 const hidden=await handler(get('/backend-api/codex/models'));assert.equal(hidden.status,200);assert.deepEqual((await hidden.json()).models,[]);
 policy={enabled:true,models:['public-review','codex-auto-review']};
 const visible=await handler(get('/backend-api/codex/models'));assert.equal(visible.status,200);assert.deepEqual((await visible.json()).models.map(model=>model.slug),['public-review']);
});
