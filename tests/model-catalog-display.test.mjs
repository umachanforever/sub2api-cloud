import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalModelCatalog,supplementGeminiBases} from '../supabase/functions/sub2api/model_catalog_display.ts';
import {filterModelCatalog} from '../supabase/functions/sub2api/model_policy.ts';
import {mappedCatalog} from '../supabase/functions/sub2api/model_mapping.ts';

test('Gemini, Claude and GPT effort aliases collapse to their actual base metadata in each wire format',()=>{
 for(const field of ['data','models'])for(const key of [field==='data'?'id':'name',...(field==='models'?['slug']:[])]){
  const model=id=>({[key]:key==='name'?'models/'+id:id,displayName:id});
  const base=model('gemini-3.8-flash');base.extension={keep:true};
  const value={extension:42,nextPageToken:'opaque',[field]:[model('gemini-3.8-flash-high'),model('gpt-6.1-sol-low'),model('claude-opus-5-5-medium'),base,model('gemini-3.8-flash-low'),model('gemini-3.8-flash-medium'),model('gemini-3.8-flash-tiered'),model('gpt-6.1-sol'),model('claude-opus-5-5'),model('claude-opus-4-6-thinking'),model('gemini-3.1-flash-image-preview'),model('gpt-6-astra'),model('gpt-6-luna')]};
  const result=canonicalModelCatalog(value,()=>true);
  assert.equal(result.extension,42);assert.equal(result.nextPageToken,'opaque');
  assert.deepEqual(result[field],[base,...value[field].slice(7)]);
 }
});

test('base aliases are synthesized only for Antigravity; exact base metadata wins and explicit variant allowlists remain usable',()=>{
 const raw={models:[{name:'models/gemini-3.8-flash-high',displayName:'Gemini 3.8 Flash High',thinkingBudget:24576,supportedGenerationMethods:['generateContent']},{name:'models/gemini-3.8-flash-low'}],nextPageToken:'next'};
 const mapped=mappedCatalog(raw,undefined,'antigravity');
 const result=filterModelCatalog(undefined,mapped);
 assert.deepEqual(result.models,[{name:'models/gemini-3.8-flash',displayName:'Gemini 3.8 Flash',supportedGenerationMethods:['generateContent']}]);
 assert.equal(result.nextPageToken,'next');
 assert.equal(mappedCatalog(raw,undefined,'gemini'),raw);
 const restricted=filterModelCatalog({enabled:true,models:['gemini-3.8-flash-high']},mapped);
 assert.deepEqual(restricted.models,[raw.models[0]]);
 const exact={name:'models/gemini-3.8-flash',displayName:'Exact metadata'};
 assert.deepEqual(supplementGeminiBases([...raw.models,exact]),[...raw.models,exact]);
});

test('unrelated model variants, custom aliases and single-model retrieval keep their identities',()=>{
 const value={data:['gpt-6-sol','gpt-6-astra','gpt-6-luna','custom-high','gemini-3-flash-preview','claude-sonnet-4-6-thinking'].map(id=>({id}))};
 assert.equal(canonicalModelCatalog(value,()=>true),value);
 const detail={id:'gemini-3.8-flash-high'};assert.equal(filterModelCatalog(undefined,detail,true),detail);
});

test('canonical Antigravity base and explicit variant details remain retrievable in both client protocols',async()=>{
 const {proxy}=await import('../supabase/functions/sub2api/proxy.ts');
 const model='gemini-3.8-flash';
 for(const prefix of ['/v1/models/','/v1beta/models/'])for(const requested of [model,model+'-high']){
  const db={config:{dataModel:'native'},async rpc(name){
   if(name==='s2a_personal_acquire')return {lease_id:crypto.randomUUID(),account:{id:'1',platform:'antigravity',type:'oauth',credential_version:1,credential_storage:'vault',credentials:{access_token:'token',project_id:'project',expires_at:Date.now()+3600000}},model_sources:{mapping:{[model+'-high']:model+'-high',[model+'-low']:model+'-low'},include_upstream:true}};
   if(name==='s2a_personal_finish')return {applied:true};
   assert.fail(name);
  },async fetchImpl(url){assert.ok(String(url).includes('fetchAvailableModels'));return Response.json({models:{[model+'-high']:{displayName:'Gemini 3.8 Flash High'},[model+'-low']:{displayName:'Gemini 3.8 Flash Low'}}});}};
  const path=prefix+requested,result=await proxy(new Request('https://gateway'+path),path,'key',db,{requestId:crypto.randomUUID(),started:Date.now()});
  assert.equal(result.status,200);const body=await result.json();assert.equal(body.id??body.name?.replace(/^models\//,''),requested);
 }
});

test('aggregated Anthropic, composite and Codex catalogs share the same effort display policy',async()=>{
 const {anthropicModelCatalog}=await import('../supabase/functions/sub2api/anthropic_catalog.ts');
 const {compositeModelCatalog}=await import('../supabase/functions/sub2api/composite_catalog.ts');
 const {applyCodexCatalogPolicy}=await import('../supabase/functions/sub2api/codex_catalog_policy.ts');
 assert.deepEqual(anthropicModelCatalog(['claude-opus-5-5-high','claude-opus-5-5']).data.map(x=>x.id),['claude-opus-5-5']);
 assert.equal(anthropicModelCatalog(['claude-opus-5-5-high','claude-opus-5-5'],undefined,'claude-opus-5-5-high').id,'claude-opus-5-5-high');
 const input={sources:[{platform:'openai',mapping:{'gpt-6.1-sol':'gpt-6.1-sol','gpt-6.1-sol-high':'gpt-6.1-sol'},passthrough:false}],routes:[]};
 assert.deepEqual(compositeModelCatalog(input).data.map(x=>x.id),['gpt-6.1-sol']);
 const base={slug:'gpt-6.1-sol',supported_reasoning_levels:[{effort:'low'},{effort:'high'}]};
 assert.deepEqual(applyCodexCatalogPolicy({models:[{slug:'gpt-6.1-sol-high'},base]}).models,[base]);
});

test('synthesized base metadata is stable across upstream order and later identity mapping updates',()=>{
 const base='gemini-3.8-flash',high={id:base+'-high',name:'models/'+base+'-high',displayName:'Gemini 3.8 Flash High',supportedGenerationMethods:['generateContent']},low={id:base+'-low',name:'models/'+base+'-low',displayName:'Gemini 3.8 Flash Low'};
 const make=(data,sources)=>filterModelCatalog(undefined,mappedCatalog({data},sources,'antigravity')).data;
 const first=make([high,low]);
 assert.equal(first[0].id,base);assert.equal(first[0].name,'models/'+base);
 assert.deepEqual(make([low,high]),first);
 assert.deepEqual(make([low,high],{mapping:{[base]:base,[base+'-high']:base+'-high'},include_upstream:true}),first);
});

test('verified provider catalogs expose one canonical Claude model for legacy aliases sharing its target',async()=>{
 const {nativeResponse}=await import('../supabase/functions/sub2api/api_key_provider.ts');
 const opus='claude-opus-4-6-thinking',sonnet='claude-sonnet-4-6';
 const sources={include_upstream:true,mapping:{[opus]:opus,[sonnet]:sonnet,'claude-opus-4-6':opus,'claude-opus-4-5-thinking':opus,'claude-haiku-4-5':sonnet,'claude-sonnet-4-5-20250929':sonnet}};
 for(const path of ['/v1/models','/v1beta/models']){
  const response=await nativeResponse(Response.json({models:[{name:'models/'+opus,displayName:'Claude Opus 4.6 (Thinking)'},{name:'models/'+sonnet,displayName:'Claude Sonnet 4.6 (Thinking)'}],nextPageToken:'opaque'}),'antigravity','models',false,AbortSignal.timeout(5000),'request',async()=>{},path,undefined,sources);
  const value=await response.json(),entries=value.data??value.models;
  assert.deepEqual(entries.map(x=>x.id??x.name.replace(/^models\//,'')),[opus,sonnet]);
  assert.equal(value.nextPageToken,'opaque');
 }
});

test('alias-only permissions and single-model retrieval retain the requested ID in every identity field',async()=>{
 const {nativeResponse}=await import('../supabase/functions/sub2api/api_key_provider.ts');
 const target='claude-opus-4-6-thinking',alias='claude-opus-4-5-thinking';
 const run=(allowlist,requested)=>nativeResponse(Response.json({models:[{name:'models/'+target,displayName:'Claude Opus 4.6 (Thinking)'}]}),'antigravity','models',false,AbortSignal.timeout(5000),'request',async()=>{},'/v1/models',allowlist,{include_upstream:true,mapping:{[target]:target,[alias]:target}},requested);
 const list=await (await run({enabled:true,models:[alias]})).json();
 assert.deepEqual(list.data.map(x=>x.id),[alias]);assert.equal(list.data[0].name,'models/'+alias);
 const detail=await (await run(undefined,alias)).json();assert.equal(detail.id,alias);assert.equal(detail.name,'models/'+alias);
});

test('mapping deduplication preserves distinct targets, alias-only catalogs and redirected canonical IDs',async()=>{
 const {deduplicateMappedModels}=await import('../supabase/functions/sub2api/model_catalog_display.ts');
 const entries=[{id:'a',display_name:'Same label'},{id:'b',display_name:'Same label'}];
 assert.deepEqual(deduplicateMappedModels({data:entries},()=>undefined,()=>true).data,entries);
 assert.deepEqual(deduplicateMappedModels({data:entries},id=>id==='a'?'missing':undefined,()=>true).data,entries);
 assert.deepEqual(deduplicateMappedModels({data:entries},id=>id==='a'?'b':'c',()=>true).data,entries);
 assert.deepEqual(deduplicateMappedModels({data:[entries[0],entries[0],entries[1]]},()=>undefined,()=>true).data,entries);
});

test('mapped aliases do not undo the single-base display for thinking families',async()=>{
 const {nativeResponse}=await import('../supabase/functions/sub2api/api_key_provider.ts');
 const base='gemini-4-argon';
 const response=await nativeResponse(Response.json({models:[{name:'models/'+base+'-high'},{name:'models/'+base+'-low'}]}),'antigravity','models',false,AbortSignal.timeout(5000),'request',async()=>{},'/v1beta/models',undefined,{include_upstream:true,mapping:{[base]:base+'-high',[base+'-high']:base+'-high',[base+'-low']:base+'-low'}});
 assert.deepEqual((await response.json()).models.map(x=>x.name),['models/'+base]);
});
