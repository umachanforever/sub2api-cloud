import assert from 'node:assert/strict';
import test from 'node:test';
import {modelAllowlist,modelCandidates,allowsModel,allowlistedModels,filterModelCatalog,DEFAULT_PROVIDER_MODELS} from '../supabase/functions/sub2api/model_policy.ts';
import {createHandler} from './handler.mjs';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
const actor='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const config={url:'https://db.example',serviceKey:'service',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[actor]};
const request=(path,method='GET',body,envelope=true)=>new Request(`https://gateway${path}`,{method,headers:{authorization:'Bearer session',...(envelope?{'x-s2a-frontend':'1'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
const app=fetcher=>createHandler(config,async(url,init)=>String(url).endsWith('/auth/v1/user')?Response.json({id:actor}):fetcher(new URL(url),init));
test('allowlists normalize ordered case-insensitive duplicates and validate trailing wildcards',()=>{
 assert.deepEqual(modelAllowlist({enabled:true,models:[' GPT-5.4 ','','gpt-5.4','claude-*']}),{enabled:true,models:['GPT-5.4','claude-*']});
 assert.deepEqual(modelAllowlist({}),{enabled:false,models:[]});
 assert.deepEqual(modelAllowlist({enabled:false,models:[' ']}),{enabled:false,models:[]});
 for(const value of [null,[],{enabled:true},{enabled:'true'},{models:null},{enabled:true,models:[' ']},{models:['gpt-*-5']},{models:['**']},{models:['a\nb']},{models:[1]},{models:['a'.repeat(201)]},{models:Array(501).fill('x')},{enabled:false,unknown:true}])assert.throws(()=>modelAllowlist(value),{status:400});
 assert.equal(allowsModel({enabled:true,models:['*']},'anything'),true);
 assert.equal(allowsModel({enabled:true,models:[]},'anything'),false);
});
test('allowlist admission follows upstream Gemini, Claude and OpenAI candidate rules',()=>{
 const policy={enabled:true,models:['claude-sonnet-4.5','gemini-2.5-pro','gpt-5.5','grok-*']};
 for(const model of ['claude-sonnet-4.5','Claude-Sonnet-4.5','claude-sonnet-4.5-thinking','models/gemini-2.5-pro','gpt-5.5-codex-high','gpt-5.5-high-','grok-4.6',''])assert.equal(allowsModel(policy,model),true,model);
 for(const model of ['claude-opus-4.6','models/gemini-2.5-flash','gpt-4.1-low','grok'])assert.equal(allowsModel(policy,model),false,model);
 assert.ok(modelCandidates('vendor/gpt-5.6-high').includes('gpt-5.6-sol'));
 assert.ok(modelCandidates('gpt-5.3_codex_high').includes('gpt-5.3-codex'));
 assert.ok(modelCandidates('claude-sonnet-4-5-thinking').includes('claude-sonnet-4-5-20250929'));
 assert.equal(allowsModel({enabled:true,models:['gpt-5.6-sol']},'gpt-5.6-unknown-high'),false);
});
test('model listings follow entry order, source wildcard membership, aliases and global deduplication',()=>{
 const source=['claude-opus-4.6','claude-sonnet-4.5','gpt-5.4','gpt-5.5-codex','gpt-5.5-mini','grok-4.6'];
 assert.deepEqual(allowlistedModels({enabled:true,models:['gpt-5.5-codex','claude-sonnet-4.5','missing']},source),['gpt-5.5-codex','claude-sonnet-4.5']);
 assert.deepEqual(allowlistedModels({enabled:true,models:['claude-*','gpt-5.5-*']},source),source.slice(0,2).concat(source.slice(3,5)));
 assert.deepEqual(allowlistedModels({enabled:true,models:['gpt-*','gpt-5.4']},source),source.slice(2,5));
 assert.deepEqual(allowlistedModels({enabled:true,models:['claude-sonnet-4.5-thinking','GPT-5.4']},source),['claude-sonnet-4.5-thinking','GPT-5.4']);
 assert.deepEqual(allowlistedModels({enabled:true,models:['claude-sonnet-4.20250514']},['Claude-Sonnet-4*']),['claude-sonnet-4.20250514']);
 assert.deepEqual(filterModelCatalog({enabled:true,models:['gemini-2.5-pro']},{models:[{name:'models/gemini-2.5-flash'},{name:'models/gemini-2.5-pro',displayName:'Keep'}],nextPageToken:'next'}),{models:[{name:'models/gemini-2.5-pro',displayName:'Keep'}],nextPageToken:'next'});
});
test('gateway supplies only server-derived candidates and denied requests never reserve or contact a provider',async()=>{
 let calls=0;
 const handler=app((url,init)=>{
  calls++;assert.ok(url.pathname.endsWith('/s2a_acquire'));const body=JSON.parse(init.body);
  assert.equal(body.p_model,'gpt-5.5-codex-high');assert.equal(body.p_billing_context.policy_model,'gpt-5.5-codex-high');assert.deepEqual(body.p_billing_context.model_candidates,['gpt-5.5-codex-high','gpt-5.5']);
  return Response.json({error:'model_not_allowed',status:403});
 });
 const response=await handler(request('/v1/responses','POST',{model:'gpt-5.5-codex-high',input:'hello',model_candidates:['allowed'],policy_model:'allowed'}));assert.equal(response.status,403);assert.equal(calls,1);
 for(const model of ['__models__','bad\0model','bad\nmodel'])assert.equal((await handler(request('/v1/responses','POST',{model,input:'hello'}))).status,400);assert.equal(calls,1);
});
test('native and OAuth model lists filter metadata and standard list order without credential leakage',async()=>{
 for(const type of ['apikey','oauth']) {
  const encrypted=await encryptCredentials(type==='apikey'?{api_key:'secret'}:{access_token:'secret',refresh_token:'refresh',chatgpt_account_id:'account'},config.encryptionKey);
  let finishes=0;
  const handler=app((url)=>{
   if(url.pathname.endsWith('/s2a_acquire'))return Response.json({lease_id:id,account:{id,...encrypted,type,platform:'openai',credential_version:1},model_allowlist:{enabled:true,models:['gpt-5.5-mini','gpt-5.4']}});
   if(url.pathname.endsWith('/s2a_finish')){finishes++;return Response.json(null);}
   return Response.json(type==='apikey'?{object:'list',data:[{id:'gpt-5.4',object:'model',owned_by:'openai',display_name:'Four'},{id:'gpt-blocked'},{id:'gpt-5.5-mini',object:'model',owned_by:'openai'}]}:{models:[{slug:'gpt-5.4',display_name:'Four',instructions:'preserved'},{slug:'gpt-blocked',instructions:'hidden'},{slug:'gpt-5.5-mini'}]});
  });
  const response=await handler(request('/v1/models'));assert.equal(response.status,200);const data=await response.json();assert.deepEqual(data.data.map(m=>m.id),['gpt-5.5-mini','gpt-5.4']);assert.equal(data.data[1].display_name,'Four');assert.equal(finishes,1);
  if(type==='oauth'){const manifest=await (await handler(request('/v1/models?client_version=0.1'))).json();assert.deepEqual(manifest.models.map(m=>m.slug),['gpt-5.4','gpt-5.5-mini']);assert.equal(manifest.models[0].instructions,'preserved');}
 }
});

test('Anthropic and Gemini catalog filtering preserves native envelopes and hides blocked single entries',async()=>{
 for(const platform of ['anthropic','gemini']) {
  const encrypted=await encryptCredentials({api_key:'secret'},config.encryptionKey);let finishes=[],single=false;
  const allowed=platform==='gemini'?'gemini-2.5-pro':'claude-sonnet-4.5';
  const handler=app((url,init)=>{
   if(url.pathname.endsWith('/s2a_acquire'))return Response.json({lease_id:id,account:{id,...encrypted,type:'apikey',platform,credential_version:1},model_allowlist:{enabled:true,models:[allowed]}});
   if(url.pathname.endsWith('/s2a_finish')){finishes.push(JSON.parse(init.body));return Response.json(null);}
   if(platform==='gemini')return Response.json(single?{name:'models/blocked'}:{models:[{name:'models/blocked'},{name:`models/${allowed}`,displayName:'Keep'}],nextPageToken:'next'});
   return Response.json(single?{id:'blocked'}:{data:[{id:'blocked'},{id:allowed,display_name:'Keep'}],has_more:true});
  });
  const path=platform==='gemini'?'/v1beta/models':'/v1/models';
  const response=await handler(request(path));assert.equal(response.status,200);const body=await response.json();
  if(platform==='gemini'){assert.equal(body.models.length,1);assert.equal(body.models[0].displayName,'Keep');assert.equal(body.nextPageToken,'next');}
  else{assert.equal(body.data.length,1);assert.equal(body.data[0].display_name,'Keep');assert.equal(body.has_more,true);}
  single=true;assert.equal((await handler(request(`${path}/${allowed}`))).status,404);assert.deepEqual(finishes.map(r=>r.p_status),[200,404]);
 }
});

test('an allowed OAuth single model absent from the source finishes its lease as a 404 failure',async()=>{
 const encrypted=await encryptCredentials({access_token:'token',refresh_token:'refresh',chatgpt_account_id:'account'},config.encryptionKey);let finished;
 const handler=app((url,init)=>{
  if(url.pathname.endsWith('/s2a_acquire'))return Response.json({lease_id:id,account:{id,...encrypted,type:'oauth',platform:'openai',credential_version:1},model_allowlist:{enabled:true,models:['missing']}});
  if(url.pathname.endsWith('/s2a_finish')){finished=JSON.parse(init.body);return Response.json(null);}
  return Response.json({models:[{slug:'actual',display_name:'Actual'}]});
 });
 assert.equal((await handler(request('/v1/models/missing'))).status,404);assert.equal(finished.p_status,404);assert.equal(finished.p_outcome,'failed');
});
