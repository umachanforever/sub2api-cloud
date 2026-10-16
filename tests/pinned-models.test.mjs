import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from './handler.mjs';
const config={url:'https://db.invalid',serviceKey:'service',encryptionKey:'',adminIds:[],dataModel:'native'};
const account=(id,type='oauth',mapping={})=>({id:String(id),type,platform:'openai',credential_version:1,credential_storage:'vault',codex_settings:{auto_sync:'false'},credentials:type==='oauth'?{access_token:'token-'+id,chatgpt_account_id:'account-'+id,model_mapping:mapping}:{api_key:'token-'+id,model_mapping:mapping}});
const get=(path='/v1/models',etag)=>new Request('https://gateway'+path,{headers:{authorization:'Bearer sk-client',...(etag?{'if-none-match':etag}:{})}});

test('pinned discovery fans out concurrently, merges in configuration order and tolerates partial failure',async()=>{
 let release;const bothStarted=new Promise(resolve=>{release=resolve;});let started=0,acquired=0;
 const app=createHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_acquire')){acquired++;return Response.json({pinned_catalog:{accounts:[account(1),account(2),account(3)],model_allowlist:{enabled:true,models:['shared','second','alias']}}});}
  assert.equal(new Headers(init.headers).get('if-none-match'),null);
  const token=new Headers(init.headers).get('authorization');
  if(token==='Bearer token-3')return new Response('private upstream error',{status:500});
  started++;if(started===2)release();await bothStarted;
  if(token==='Bearer token-1'){await new Promise(resolve=>setTimeout(resolve,10));return Response.json({models:[{slug:'shared',display_name:'First metadata',instructions:'first'},{slug:'alias',instructions:'alias'}]});}
  return Response.json({models:[{slug:'shared',display_name:'Second metadata'},{slug:'second',instructions:'second'}]});
 });
 const result=await app(get('/backend-api/codex/models'));assert.equal(result.status,200);const body=await result.json();
 assert.deepEqual(body.models.map(m=>m.slug),['shared','alias','second']);assert.equal(body.models[0].instructions,'first');assert.equal(body.models[0].display_name,'First metadata');assert.equal(acquired,1);
 const cached=await app(get('/backend-api/codex/models',result.headers.get('etag')));assert.equal(cached.status,304);assert.equal(await cached.text(),'');
});

test('pinned ordinary catalogs preserve API-key metadata, mappings, allowlists and detail isolation',async()=>{
 const app=createHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({pinned_catalog:{accounts:[account(1,'apikey',{'public-model':'upstream-model'})],model_allowlist:{enabled:true,models:['public-model']}}});
  assert.equal(new URL(url).pathname,'/v1/models');return Response.json({object:'list',data:[{id:'upstream-model',owned_by:'source',created:123,extra:{context:456}},{id:'hidden'}]});
 });
 const result=await app(get());assert.equal(result.status,200);const body=await result.json();assert.deepEqual(body.data.map(m=>m.id),['public-model']);assert.equal(body.data[0].created,123);assert.equal(body.data[0].owned_by,'source');assert.equal(body.data[0].extra.context,456);
 const detail=await app(get('/v1/models/public-model','*'));assert.equal(detail.status,200);assert.equal(detail.headers.get('etag'),null);assert.equal((await detail.json()).extra.context,456);
 assert.equal((await app(get('/v1/models/hidden'))).status,404);
});

test('pinned API-key manifests complete missing metadata while preserving provider fields',async()=>{
 const app=createHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({pinned_catalog:{accounts:[account(1,'apikey')]}});
  assert.equal(new URL(url).searchParams.get('client_version'),'0.150.0');assert.ok(new Headers(init.headers).get('version'));
  return Response.json({object:'list',data:[{id:'gpt-6.1-sol',display_name:'Provider name',context_window:999999,model_messages:{provider_field:'kept'}},{id:'gpt-image-1'}]});
 });
 const response=await app(get('/v1/models?client_version=0.150.0'));assert.equal(response.status,200);const body=await response.json();assert.equal(body.data,undefined);assert.equal(body.models.length,1);assert.equal(body.models[0].slug,'gpt-6.1-sol');assert.equal(body.models[0].display_name,'Provider name');assert.equal(body.models[0].context_window,999999);assert.ok(body.models[0].model_messages.instructions_template.length>1000);assert.equal(body.models[0].model_messages.provider_field,'kept');
});

test('all pinned failures honor scheduler fallback and never expose upstream errors',async()=>{
 for(const fallback of [false,true]){
  let acquisitions=0,finishes=0;
  const app=createHandler(config,async(url,init)=>{
   if(String(url).endsWith('/s2a_personal_acquire')){
    const args=JSON.parse(init.body);acquisitions++;
    if(acquisitions===1){assert.equal(args.p_billing_context.pinned_models_fallback,undefined);return Response.json({pinned_catalog:{accounts:[account(1)],fallback_to_scheduler:fallback}});}
    assert.equal(args.p_billing_context.pinned_models_fallback,true);return Response.json({lease_id:'lease',account:account(2)});
   }
   if(String(url).endsWith('/s2a_personal_finish')){finishes++;return Response.json(null);}
   if(new Headers(init.headers).get('authorization')==='Bearer token-1')return new Response('private-secret',{status:403});
   return Response.json({models:[{slug:'gpt-6.1-sol'}]});
  });
  const response=await app(get());assert.equal(response.status,fallback?200:502);assert.equal(acquisitions,fallback?2:1);assert.equal(finishes,fallback?1:0);assert.ok(!(await response.text()).includes('private-secret'));
 }
});

test('invalid and empty pinned configurations fail closed and cancellation cannot fall back',async()=>{
 for(const catalog of [{accounts:[]},{accounts:[],error:'invalid_pinned_model_config',status:503}]){
  let calls=0;const app=createHandler(config,async(url)=>{if(String(url).endsWith('/s2a_personal_acquire'))calls++;return Response.json({pinned_catalog:catalog});});
  assert.equal((await app(get())).status,503);assert.equal(calls,1);
 }
 const controller=new AbortController();
 const app=createHandler(config,async(url)=>{if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({pinned_catalog:{accounts:[account(1)],fallback_to_scheduler:true}});controller.abort();throw controller.signal.reason;});
 const request=new Request(get(),{signal:controller.signal});assert.notEqual((await app(request)).status,200);
});

test('pinned mapping projects only available public models, expands allowlist names and honors passthrough',async()=>{
 for(const passthrough of [false,true]){
  const source={...account(1,'apikey',{'public*':'upstream','missing':'absent'}),model_passthrough:passthrough};
  const app=createHandler(config,async(url)=>{
   if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({pinned_catalog:{accounts:[source],...(passthrough?{}:{model_allowlist:{enabled:true,models:['public-version','missing']}})}});
   return Response.json({object:'list',data:[{id:'upstream',display_name:'Source',created:123},{id:'unmapped'}]});
  });
  const response=await app(get());assert.equal(response.status,200);const body=await response.json();assert.deepEqual(body.data.map(m=>m.id),passthrough?['upstream','unmapped']:['public-version']);
  if(!passthrough){assert.equal(body.data[0].display_name,'public-version');assert.equal(body.data[0].created,123);}
 }
});

test('an authoritative empty pinned catalog succeeds without scheduler fallback',async()=>{
 let acquired=0;
 const app=createHandler(config,async(url)=>{
  if(String(url).endsWith('/s2a_personal_acquire')){acquired++;return Response.json({pinned_catalog:{accounts:[account(1)],fallback_to_scheduler:true}});}
  return Response.json({models:[]});
 });
 const response=await app(get());assert.equal(response.status,200);assert.deepEqual((await response.json()).data,[]);assert.equal(acquired,1);
});

test('scheduler fallback retries failed accounts and keeps pinned public mapping semantics',async()=>{
 const selected=[];let acquisitions=0;const finishes=[];
 const app=createHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_acquire')){
   const args=JSON.parse(init.body);acquisitions++;
   if(acquisitions===1)return Response.json({pinned_catalog:{accounts:[account(1)],fallback_to_scheduler:true}});
   assert.equal(args.p_billing_context.pinned_models_fallback,true);
   if(acquisitions===3)assert.deepEqual(args.p_excluded,['2']);
   const source=account(acquisitions,'apikey',{'public':'upstream'});selected.push(source.id);return Response.json({lease_id:'lease-'+source.id,account:source});
  }
  if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json(null);}
  if(new Headers(init.headers).get('authorization')!=='Bearer token-3')return new Response('private error',{status:500});
  return Response.json({object:'list',data:[{id:'upstream',created:123},{id:'unmapped'}]});
 });
 const response=await app(get());assert.equal(response.status,200);assert.deepEqual((await response.json()).data.map(m=>m.id),['public']);assert.deepEqual(selected,['2','3']);assert.deepEqual(finishes.map(value=>value.p_status),[502,200]);
});

test('pinned catalogs reuse successful source reads for a minute and isolate rotations and policy changes',async()=>{
 let reads=0,version=1,allowed=['first'];
 const app=createHandler(config,async(url)=>{
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({pinned_catalog:{accounts:[{...account(1),credential_version:version}],model_allowlist:{enabled:true,models:allowed}}});
  reads++;return Response.json({models:[{slug:'first'},{slug:'second'}]});
 });
 assert.deepEqual((await (await app(get())).json()).data.map(m=>m.id),['first']);
 assert.equal((await app(get())).status,200);assert.equal(reads,1);
 allowed=['second'];assert.deepEqual((await (await app(get())).json()).data.map(m=>m.id),['second']);assert.equal(reads,2);
 version=2;assert.equal((await app(get())).status,200);assert.equal(reads,3);
 const original=Date.now;const future=original()+61000;
 try{Date.now=()=>future;assert.equal((await app(get())).status,200);assert.equal(reads,4);}finally{Date.now=original;}
});

test('synced API-key model metadata fills live omissions and preserves explicit nullable capability fields',async()=>{
 const source={...account(1,'apikey'),model_metadata:{models:{'gpt-6.1-sol':{id:'gpt-6.1-sol',display_name:'Synced name',description:'Synced description',reasoning:true,default_reasoning_level:'high',supported_reasoning_levels:['low','high'],input_modalities:['text','image'],context_window:123456,max_context_window:234567,codex_tool_capabilities:{supports_search_tool:true,tool_mode:'synced',use_responses_lite:true,service_tiers:[{id:'fast',name:'Fast'}]}}}}};
 let live=false;
 const app=createHandler(config,async(url)=>{
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({pinned_catalog:{accounts:[source]}});
  return Response.json({models:[{slug:'gpt-6.1-sol',supports_search_tool:false,tool_mode:null,use_responses_lite:null,service_tiers:null,...(live?{display_name:'Live name',context_window:999999,input_modalities:['text']}:{})}]});
 });
 const first=(await (await app(get('/backend-api/codex/models'))).json()).models[0];
 assert.equal(first.display_name,'Synced name');assert.equal(first.description,'Synced description');assert.equal(first.context_window,123456);assert.equal(first.max_context_window,234567);assert.deepEqual(first.input_modalities,['text','image']);assert.equal(first.default_reasoning_level,'high');assert.deepEqual(first.supported_reasoning_levels.map(level=>level.effort),['low','high']);assert.equal(first.supports_search_tool,false);assert.equal(first.tool_mode,null);assert.equal(first.use_responses_lite,null);assert.deepEqual(first.service_tiers,[]);
 live=true;source.credential_version++;
 const second=(await (await app(get('/backend-api/codex/models'))).json()).models[0];assert.equal(second.display_name,'Live name');assert.equal(second.context_window,999999);assert.deepEqual(second.input_modalities,['text']);
});

test('synced metadata follows mapped targets and changing snapshots invalidates cached catalogs',async()=>{
 const source={...account(1,'apikey',{'public':'target'}),model_metadata:{models:{target:{id:'target',display_name:'Target private name',description:'Target description',reasoning:false,input_modalities:['text'],context_window:123456,codex_tool_capabilities:{supports_search_tool:false}}}}};
 let reads=0;
 const app=createHandler(config,async(url)=>{
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({pinned_catalog:{accounts:[source]}});
  reads++;return Response.json({object:'list',data:[{id:'target'}]});
 });
 const first=(await (await app(get('/backend-api/codex/models'))).json()).models[0];assert.equal(first.slug,'public');assert.equal(first.display_name,'public');assert.equal(first.context_window,123456);assert.equal(first.supports_search_tool,false);assert.equal(first.default_reasoning_level,'none');
 source.model_metadata.models.target.context_window=654321;
 const second=(await (await app(get('/backend-api/codex/models'))).json()).models[0];assert.equal(second.context_window,654321);assert.equal(reads,2);
});

test('API-key manifests disable Responses Lite for targeted models and their public aliases',async()=>{
 const source={...account(1,'apikey',{'public':'gpt-6.1-sol'})};
 const app=createHandler(config,async(url)=>{
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({pinned_catalog:{accounts:[source]}});
  return Response.json({models:[{slug:'gpt-6.1-sol',use_responses_lite:true}]});
 });
 const response=await app(get('/backend-api/codex/models'));assert.equal(response.status,200);const model=(await response.json()).models[0];assert.equal(model.slug,'public');assert.equal(model.use_responses_lite,false);
});
