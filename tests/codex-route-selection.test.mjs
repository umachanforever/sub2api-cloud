import test from 'node:test';
import assert from 'node:assert/strict';
import {compositeCodexCatalog,completeCompositeCodexCatalog,compositeModelCatalog} from '../supabase/functions/sub2api/composite_catalog.ts';
import {codexCatalogDescriptor} from '../supabase/functions/sub2api/codex_catalog.ts';
import {createHandler} from './handler.mjs';
const target='gpt-6.1-sol';
const source={id:'1',platform:'openai',type:'apikey',passthrough:false,official:false,mapping:{public:target,[target]:target},modalities:{[target]:['text','image']},metadata:{models:{[target]:{id:target,context_window:12345,max_context_window:24690,reasoning:true,supported_reasoning_levels:['high'],default_reasoning_level:'high',input_modalities:['text','image'],codex_tool_capabilities:{supports_search_tool:true}}}}};
const route=(model,match_type='exact',endpoint='chat_completions',upstream_model=target)=>({model,match_type,endpoint,platform:'openai',upstream_model});
const input=routes=>({sources:[source],capability_sources:[source],routes});
for(const rule of [route('public'),route('pub','prefix')])test(rule.match_type+' routes for other endpoints block inferred Responses capabilities',async()=>{
 const value=input([rule]);
 const basic=compositeCodexCatalog(value).models.find(m=>m.slug==='public');assert.deepEqual(basic.input_modalities,['text']);
 const completed=(await completeCompositeCodexCatalog(value)).models.find(m=>m.slug==='public');
 assert.notEqual(completed.context_window,12345);assert.equal(completed.supports_search_tool,false);assert.deepEqual(completed.input_modalities,['text']);
 assert.deepEqual(compositeModelCatalog(value).data.map(m=>m.id),[target,'public']);
});
test('a matching Responses prefix overrides a Chat-only exact rule for capability resolution',async()=>{
 const model=(await completeCompositeCodexCatalog(input([route('public'),route('pub','prefix','responses')]))).models.find(m=>m.slug==='public');
 assert.equal(model.context_window,12345);assert.equal(model.supports_search_tool,true);assert.deepEqual(model.input_modalities,['text','image']);
});
test('explicit Responses routes choose descriptor identity before account mappings',async()=>{
 const account={...source,mapping:{public:'gpt-6-sol',[target]:'gpt-6-astra'},metadata:undefined};
 const value={sources:[account],capability_sources:[account],routes:[route('public','exact','responses')]};
 const expected=codexCatalogDescriptor(target);
 for(const model of [compositeCodexCatalog(value).models.find(m=>m.slug==='public'),(await completeCompositeCodexCatalog(value)).models.find(m=>m.slug==='public')]){
  assert.equal(model.slug,'public');assert.equal(model.model_messages.instructions_template,expected.model_messages.instructions_template);assert.equal(model.context_window,expected.context_window);
 }
});
test('handler route edits change the final manifest ETag and preserve ordinary model entries',async()=>{
 const config={url:'https://db.invalid',serviceKey:'service',encryptionKey:'',adminIds:[],dataModel:'native'};
 const value=input([route('public')]);
 const handler=createHandler(config,async url=>{
  assert.ok(String(url).endsWith('/s2a_personal_acquire'));return Response.json({composite_catalog:value});
 });
 const get=(path,tag)=>new Request('https://gateway'+path,{headers:{authorization:'Bearer sk-client',...(tag?{'if-none-match':tag}:{})}});
 const first=await handler(get('/backend-api/codex/models'));assert.equal(first.status,200);assert.equal((await first.json()).models.find(m=>m.slug==='public').supports_search_tool,false);
 const tag=first.headers.get('etag');assert.equal((await handler(get('/backend-api/codex/models',tag))).status,304);
 value.routes.push(route('public','exact','responses'));
 const changed=await handler(get('/backend-api/codex/models',tag));assert.equal(changed.status,200);assert.equal((await changed.json()).models.find(m=>m.slug==='public').context_window,12345);
 assert.deepEqual((await (await handler(get('/v1/models'))).json()).data.map(m=>m.id),[target,'public']);
});
