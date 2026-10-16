import test from 'node:test';
import assert from 'node:assert/strict';
import {apiKeyCodexCapabilities,astraCodexModel} from '../supabase/functions/sub2api/api_key_codex_capabilities.ts';
import {completePinnedMetadata} from '../supabase/functions/sub2api/pinned_model_metadata.ts';
import {codexCatalogDescriptor} from '../supabase/functions/sub2api/codex_catalog.ts';
import {createHandler} from './handler.mjs';
test('official API-key tool defaults cover original Astra and Sol spellings without extending other families',()=>{
 for(const id of ['gpt-6','gpt-6-astra','openai/GPT_6_ASTRA_20261015','gpt-6-astra-high','gpt-6.1-sol','openai/gpt-6.1-sol-max','gpt-6.1-sol-openai-compact']){
  const caps=apiKeyCodexCapabilities(id);assert.equal(caps.supports_search_tool,true);assert.equal(caps.apply_patch_tool_type,'freeform');assert.equal(caps.comp_hash,'3000');assert.equal(caps.tool_mode,null);assert.equal(caps.use_responses_lite,false);
  assert.equal(!!caps.service_tiers,astraCodexModel(id));
 }
 for(const id of ['gpt-6-sol','gpt-6-luna','gpt-6.2-sol','gpt-6.1-sol-ultra','gpt-6.1-sol-20261015','gpt-5.6-sol'])assert.deepEqual(apiKeyCodexCapabilities(id),{});
 for(const base of ['https://compatible.example','https://api.openai.com.evil.example','https://evil-api.openai.com','invalid'])assert.deepEqual(apiKeyCodexCapabilities('gpt-6-astra',base),{});
 assert.equal(apiKeyCodexCapabilities('gpt-6-astra','https://API.OPENAI.COM/v1').supports_search_tool,true);
 const dotted=apiKeyCodexCapabilities('gpt-6-astra','https://api.openai.com./v1');assert.equal(dotted.supports_search_tool,undefined);assert.deepEqual(dotted.service_tiers.map(t=>t.id),['priority','ultrafast']);
});
test('live and synced nullable capabilities remain authoritative before official defaults',()=>{
 const snapshot={models:{'gpt-6-astra':{id:'gpt-6-astra',codex_tool_capabilities:{comp_hash:'synced',supports_search_tool:false}}}};
 const provided={slug:'gpt-6-astra',tool_mode:null,use_responses_lite:null,service_tiers:null,apply_patch_tool_type:'custom'};
 const result=completePinnedMetadata(codexCatalogDescriptor(provided.slug),provided,snapshot,{});
 assert.equal(result.supports_search_tool,false);assert.equal(result.comp_hash,'synced');assert.equal(result.tool_mode,null);assert.equal(result.use_responses_lite,null);assert.equal(result.apply_patch_tool_type,'custom');assert.deepEqual(result.service_tiers,[]);
 for(const target of ['gpt-6-astra-20261015','openai/GPT_6_ASTRA_HIGH']){
  const entry=completePinnedMetadata(codexCatalogDescriptor('public'),{slug:'public',use_responses_lite:true},undefined,{public:target},'https://compatible.example');
  assert.equal(entry.use_responses_lite,false);
 }
});
for(const pinned of [false,true])test((pinned?'pinned':'scheduled')+' API-key manifests expose official tools and Astra tiers while respecting live declarations',async()=>{
 const config={url:'https://db.invalid',serviceKey:'service',encryptionKey:'',adminIds:[],dataModel:'native'};
 const account={id:'1',type:'apikey',platform:'openai',credential_storage:'vault',credentials:{api_key:'synthetic'},credential_version:1,codex_settings:{auto_sync:'false'}};
 const handler=createHandler(config,async(url)=>{
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json(pinned?{pinned_catalog:{accounts:[account]}}:{lease_id:'lease',account});
  if(String(url).endsWith('/s2a_personal_finish'))return Response.json(null);
  return Response.json({models:[{slug:'gpt-6-astra-20261015',use_responses_lite:true},{slug:'gpt-6.1-sol',supports_search_tool:false,tool_mode:'custom',comp_hash:null,service_tiers:[]}]});
 });
 const response=await handler(new Request('https://gateway/backend-api/codex/models',{headers:{authorization:'Bearer sk-client'}}));assert.equal(response.status,200);
 const [astra,sol]=(await response.json()).models;
 assert.equal(astra.supports_search_tool,true);assert.equal(astra.use_responses_lite,false);assert.equal(astra.tool_mode,null);assert.deepEqual(astra.service_tiers.map(t=>t.id),['priority','ultrafast']);
 assert.equal(sol.supports_search_tool,false);assert.equal(sol.tool_mode,'custom');assert.equal(sol.comp_hash,null);assert.deepEqual(sol.service_tiers,[]);
});
