import assert from 'node:assert/strict';
import test from 'node:test';
import {modelMapping,accountMappingInput,mappedTarget,mappedCatalog} from '../supabase/functions/sub2api/model_mapping.ts';
import {createHandler} from './handler.mjs';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
const actor='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const config={url:'https://db.example',serviceKey:'service',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[actor]};
const request=(path,method='GET',body)=>new Request(`https://gateway${path}`,{method,headers:{authorization:'Bearer session'},...(body===undefined?{}:{body:JSON.stringify(body)})});
const app=fetcher=>createHandler(config,async(url,init)=>String(url).endsWith('/auth/v1/user')?Response.json({id:actor}):fetcher(new URL(url),init));
test('mapping validation accepts trailing patterns and rejects ambiguous or unsafe inputs',()=>{
 assert.deepEqual(modelMapping({' alias ':' target ','x*':'gpt-4.1'}),{alias:'target','x*':'gpt-4.1'});
 for(const value of [null,[],{'':'target'},{'a*b':'target'},{a:'tar*'},{a:1},{a:'\nsecret'},{a:'x'.repeat(201)},{' a':'x',a:'y'}])assert.throws(()=>modelMapping(value),{status:400});
 const body={credentials:{api_key:'secret',model_mapping:{a:'b'}}};assert.deepEqual(accountMappingInput(body),{a:'b'});assert.deepEqual(body.credentials,{api_key:'secret'});
 assert.equal(accountMappingInput({credentials:{api_key:'secret'}}),undefined);
 for(const body of [{model_mapping:null},{credentials:{model_mapping:null}},{model_mapping:{},credentials:{model_mapping:{}}}])assert.throws(()=>accountMappingInput(body),{status:400});
});
test('mapping lookup is exact then longest case-sensitive wildcard with prototype-safe keys',()=>{
 const mapping=modelMapping(JSON.parse('{"*":"fallback","alias*":"broad","alias-long*":"specific","alias-long":"exact","__proto__":"safe"}'));
 assert.equal(mappedTarget(mapping,'alias-long','openai'),'exact');assert.equal(mappedTarget(mapping,'alias-longer','openai'),'specific');assert.equal(mappedTarget(mapping,'Alias-long','openai'),'fallback');assert.equal(mappedTarget(mapping,'__proto__','openai'),'safe');assert.equal(mappedTarget({},'constructor','openai'),undefined);
 assert.equal(mappedTarget({'gemini-3.1-pro-preview':'mapped'},'gemini-3.1-pro-preview-customtools','gemini'),'mapped');
 assert.equal(mappedTarget({'gemini-3.1-pro-preview':'mapped'},'gemini-3.1-pro-preview-customtools','antigravity'),'mapped');
});
test('mapped catalogs preserve metadata and envelope fields while exposing only configured aliases',()=>{
 const sources={mapping:{alias:'gpt-4.1','family*':'gpt-4.1'},include_upstream:false};
 const result=mappedCatalog({data:[{id:'gpt-4.1',owned_by:'vendor',display_name:'Keep'}],has_more:true},sources,'openai');assert.deepEqual(result.data.map(m=>m.id),['alias','family*']);assert.equal(result.data[0].display_name,'Keep');assert.equal(result.has_more,true);
 const manifest=mappedCatalog({models:[{slug:'gpt-4.1',instructions:'Keep'}],revision:4},sources,'openai');assert.deepEqual(manifest.models,[{slug:'alias',instructions:'Keep'}]);assert.equal(manifest.revision,4);
 const gemini=mappedCatalog({models:[{name:'models/gpt-4.1',displayName:'Keep'}],nextPageToken:'next'},sources,'gemini');assert.equal(gemini.models[0].name,'models/alias');assert.equal(gemini.models[0].displayName,'Keep');assert.equal(gemini.nextPageToken,'next');
 assert.equal(mappedCatalog({data:[{id:'gpt-4.1'}]},{...sources,include_upstream:true},'openai').data.length,3);
});
test('provider requests forward the reserved model and retain requested model in trusted policy context',async()=>{
 for(const platform of ['openai','anthropic','gemini']) {
  const encrypted=await encryptCredentials({api_key:'secret'},config.encryptionKey);let forwarded=false,finished=false;
  const handler=app((url,init)=>{
   if(url.pathname.endsWith('/s2a_acquire')){const args=JSON.parse(init.body);assert.equal(args.p_model,'alias');assert.equal(args.p_billing_context.policy_model,'alias');return Response.json({lease_id:id,account:{id,...encrypted,type:'apikey',platform,credential_version:1},upstream_model:'gpt-4.1'});}
   if(url.pathname.endsWith('/s2a_finish')){finished=true;return Response.json(null);}
   forwarded=true;
   if(platform==='gemini'){assert.equal(url.pathname,'/v1beta/models/gpt-4.1:generateContent');return Response.json({candidates:[{content:{parts:[{text:'OK'}]}}],usageMetadata:{promptTokenCount:1,candidatesTokenCount:1}});}
   assert.equal(JSON.parse(init.body).model,'gpt-4.1');return Response.json(platform==='anthropic'?{type:'message',content:[{type:'text',text:'OK'}],usage:{input_tokens:1,output_tokens:1}}:{choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}});
  });
  const path=platform==='gemini'?'/v1beta/models/alias:generateContent':platform==='anthropic'?'/v1/messages':'/v1/chat/completions';
  const body=platform==='gemini'?{contents:[{parts:[{text:'Hi'}]}]}:{model:'alias',messages:[{role:'user',content:'Hi'}],max_tokens:10};
  assert.equal((await handler(request(path,'POST',body))).status,200,platform);assert.equal(forwarded,true);assert.equal(finished,true);
 }
});
test('single mapped catalog model uses provider list and returns alias metadata',async()=>{
 const encrypted=await encryptCredentials({api_key:'secret'},config.encryptionKey);
 const handler=app((url,init)=>{
  if(url.pathname.endsWith('/s2a_acquire'))return Response.json({lease_id:id,account:{id,...encrypted,type:'apikey',platform:'openai',credential_version:1},model_sources:{mapping:{alias:'gpt-4.1'},include_upstream:false}});
  if(url.pathname.endsWith('/s2a_finish'))return Response.json(null);
  assert.equal(url.pathname,'/v1/models');return Response.json({data:[{id:'gpt-4.1',object:'model',owned_by:'vendor',display_name:'Keep'}]});
 });
 const response=await handler(request('/v1/models/alias'));assert.equal(response.status,200);const data=await response.json();assert.equal(data.id,'alias');assert.equal(data.display_name,'Keep');
});
