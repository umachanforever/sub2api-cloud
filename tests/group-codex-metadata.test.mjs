import test from 'node:test';
import assert from 'node:assert/strict';
import {completeCompositeCodexCatalog} from '../supabase/functions/sub2api/composite_catalog.ts';
import {originalCodexMetadata} from '../supabase/functions/sub2api/original_chat_bridge.ts';
import {createHandler} from './handler.mjs';
const metadata=(context=200000,levels=['low','high'],caps={})=>({id:'target',reasoning:true,supported_reasoning_levels:levels,default_reasoning_level:'high',input_modalities:['text'],context_window:context,max_context_window:context*2,codex_tool_capabilities:caps});
const source=(id,raw,target='target')=>({id:String(id),platform:'anthropic',type:'apikey',mapping:{public:target},official:false,passthrough:false,modalities:{},...(raw?{metadata:{models:{[target]:raw}}}:{})});
const input=sources=>({sources:[{platform:'anthropic',mapping:{public:'target'},passthrough:false}],capability_sources:sources,routes:[]});
test('original Go metadata intersection narrows context, reasoning and conflicting nullable tools',async()=>{
 const caps={supports_search_tool:true,use_responses_lite:true,tool_mode:'first',service_tiers:[{id:'priority',name:'Fast',description:'Fast'}]};
 const result=await completeCompositeCodexCatalog(input([source(1,metadata(200000,['low','high'],caps)),source(2,metadata(100000,['high','max'],{...caps,supports_search_tool:false,use_responses_lite:false,tool_mode:'second',service_tiers:[]}))]));
 const model=result.models[0];assert.equal(model.slug,'public');assert.equal(model.display_name,'public');
 assert.equal(model.context_window,100000);assert.equal(model.max_context_window,200000);assert.deepEqual(model.supported_reasoning_levels.map(v=>v.effort),['high']);assert.equal(model.default_reasoning_level,'high');
 assert.equal(model.supports_search_tool,false);assert.equal(model.use_responses_lite,false);assert.equal(model.tool_mode,null);assert.deepEqual(model.service_tiers,[]);
});
test('missing snapshots preserve descriptor defaults but still narrow declared tool capabilities',async()=>{
 const model=(await completeCompositeCodexCatalog(input([source(1,metadata(12345,['high'],{supports_search_tool:true})),source(2)]))).models[0];
 assert.notEqual(model.context_window,12345);assert.equal(model.supports_search_tool,false);assert.equal(model.slug,'public');
 const conflicting=(await completeCompositeCodexCatalog(input([source(1,undefined,'first'),source(2,undefined,'second')]))).models[0];
 assert.equal(conflicting.default_reasoning_level,null);assert.deepEqual(conflicting.supported_reasoning_levels,[]);assert.deepEqual(conflicting.input_modalities,['text']);
});
test('explicit model routing limits metadata candidates and disables ambiguous-target fallback',async()=>{
 const value=input([source(1,metadata(12345,['high']), 'first'),source(2,undefined,'second')]);
 value.model_routing={public:['1']};
 const model=(await completeCompositeCodexCatalog(value)).models[0];assert.equal(model.context_window,12345);assert.deepEqual(model.supported_reasoning_levels.map(v=>v.effort),['high']);
 value.model_routing={'pub*':[1]};assert.equal((await completeCompositeCodexCatalog(value)).models[0].context_window,12345);
});
test('Go ABI validates candidate bounds and retains unknown descriptor fields',async()=>{
 await assert.rejects(originalCodexMetadata({model:'public',descriptor:{},candidates:[]}));
 const result=await originalCodexMetadata({model:'public',descriptor:{extension:{keep:true},context_window:999},candidates:[metadata(1000,['high'])]});
 assert.deepEqual(result.extension,{keep:true});assert.equal(result.context_window,1000);assert.equal(result.max_context_window,2000);
});
test('OpenAI-specific Responses Lite guards do not rewrite another provider metadata',async()=>{
 const model=(await completeCompositeCodexCatalog(input([source(1,metadata(20000,['high'],{use_responses_lite:true}),'gpt-6-astra')]))).models[0];
 assert.equal(model.use_responses_lite,true);
});
for(const platform of ['composite','anthropic'])test(platform+' handler applies real Go metadata and final conditional ETags',async()=>{
 const config={url:'https://db.invalid',serviceKey:'service',encryptionKey:'',adminIds:[],dataModel:'native'};
 const sources=[source(1,metadata(12345,['high'])),source(2,metadata(20000,['high','max']))];
 const handler=createHandler(config,async(url)=>{
  assert.ok(String(url).endsWith('/s2a_personal_acquire'),'Catalog performed unnecessary provider I/O');
  return Response.json(platform==='composite'?{composite_catalog:input(sources)}:{anthropic_catalog:['public'],anthropic_capabilities:sources});
 });
 const get=tag=>new Request('https://gateway/backend-api/codex/models',{headers:{authorization:'Bearer sk-client',...(tag?{'if-none-match':tag}:{})}});
 const first=await handler(get());assert.equal(first.status,200);assert.equal((await first.json()).models[0].context_window,12345);
 const tag=first.headers.get('etag');assert.equal((await handler(get(tag))).status,304);
 sources[0].metadata.models.target.context_window=10000;
 const changed=await handler(get(tag));assert.equal(changed.status,200);assert.equal((await changed.json()).models[0].context_window,10000);
});
