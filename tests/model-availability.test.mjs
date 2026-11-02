import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelAvailability} from '../supabase/functions/sub2api/model_availability.ts';
const request=()=>new Request('https://gateway/v1/models',{headers:{authorization:'Bearer client','x-real-ip':'192.0.2.1'}});
const listing=()=>Response.json({data:[{id:'gpt-custom'},{id:'gemini-good',extension:42},{id:'gemini-bad'},{id:'gemini-*'}],nextPageToken:'opaque',extension:true},{headers:{etag:'"unfiltered"','last-modified':'yesterday'}});
const success=()=>Response.json({choices:[{message:{content:'OK'}}]});

test('only successful Gemini inference survives while other providers, metadata and pagination remain intact',async()=>{
 const cache=new ModelAvailability();const calls=[];
 const result=await cache.filter(listing(),request(),'key',false,async(req,path)=>{
  const body=await req.json();calls.push(body.model);
  assert.equal(path,'/v1/chat/completions');assert.equal(body.max_tokens,8);assert.equal(body.stream,false);
  assert.equal(req.headers.get('x-real-ip'),'192.0.2.1');
  return body.model==='gemini-good'?success():Response.json({error:{}},{status:404});
 });
 assert.deepEqual(calls.sort(),['gemini-bad','gemini-good']);
 assert.deepEqual(await result.json(),{data:[{id:'gpt-custom'},{id:'gemini-good',extension:42}],nextPageToken:'opaque',extension:true});
 assert.equal(result.headers.get('etag'),null);assert.equal(result.headers.get('last-modified'),null);
});

test('success and failure TTLs expire independently and cache is isolated by key, protocol and model metadata',async()=>{
 let now=0,calls=0;const cache=new ModelAvailability(()=>now);
 const run=(scope='key',extension=42)=>cache.filter(Response.json({data:[{id:'gemini-good',extension},{id:'gemini-bad'}]}),request(),scope,false,async req=>{calls++;return (await req.json()).model==='gemini-good'?success():new Response(null,{status:404});});
 await run();assert.equal(calls,2);await run();assert.equal(calls,2);
 now=5*60_000;await run();assert.equal(calls,3);
 now=10*60_000;await run();assert.equal(calls,5);
 await run('other-key');assert.equal(calls,7);
 await run('key',43);assert.equal(calls,8);
});

test('transient failures retry after 15 seconds and duplicate simultaneous listings share probes',async()=>{
 let now=0,calls=0;const cache=new ModelAvailability(()=>now);
 const run=()=>cache.filter(Response.json({data:[{id:'gemini-good'}]}),request(),'key',false,async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,10));return calls===1?new Response(null,{status:429}):success();});
 const first=await Promise.all([run(),run()]);assert.equal(calls,1);assert.deepEqual((await first[0].json()).data,[]);
 await run();assert.equal(calls,1);now=15_000;
 assert.equal((await (await run()).json()).data.length,1);assert.equal(calls,2);
});

test('native probes require candidates and do not treat a blocked response or malformed success as available',async()=>{
 const cache=new ModelAvailability();const models=['gemini-good','gemini-blocked','gemini-invalid'];
 const result=await cache.filter(Response.json({models:models.map(id=>({name:'models/'+id}))}),request(),'key',true,async(req,path)=>{
  const payload=await req.json();assert.equal(payload.generationConfig.maxOutputTokens,8);assert.ok(payload.contents.length);
  if(path.includes('gemini-good'))return Response.json({candidates:[{content:{parts:[{text:'OK'}]}}]});
  return path.includes('gemini-blocked')?Response.json({promptFeedback:{blockReason:'SAFETY'}}):new Response('invalid');
 });
 assert.deepEqual((await result.json()).models,[{name:'models/gemini-good'}]);
});

test('non-Gemini catalogs and upstream failures do not dispatch inference',async()=>{
 const cache=new ModelAvailability();let calls=0;
 for(const response of [Response.json({data:[{id:'gpt-6-sol'}]}),new Response(null,{status:304}),new Response('error',{status:503})])
  assert.equal(await cache.filter(response,request(),'key',false,async()=>{calls++;return success();}),response);
 assert.equal(calls,0);
});

import {createBackendHandler} from './handler.mjs';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
test('gateway verifies real inference, excludes rejected models, settles probe leases and reuses successful verification',async()=>{
 const config={url:'https://db.invalid',serviceKey:'service',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
 const stored=await encryptCredentials({api_key:'provider-key'},config.encryptionKey);
 const probes=[],finishes=[];
 const app=createBackendHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_key_policy'))return Response.json({platform:'gemini'});
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:crypto.randomUUID(),account:{...stored,id:'account',type:'apikey',platform:'gemini',credential_version:1}});
  if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
  if(String(url).includes('/rpc/'))return Response.json(null);
  if(init.method==='GET')return Response.json({models:[{name:'models/gemini-good',displayName:'Keep'},{name:'models/gemini-bad'}],nextPageToken:'next'});
  probes.push(String(url));assert.equal(init.headers.get('x-goog-api-key'),'provider-key');
  assert.equal(JSON.parse(init.body).generationConfig.maxOutputTokens,8);
  return String(url).includes('gemini-good')?Response.json({candidates:[{content:{parts:[{text:'OK'}]}}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:1}}):Response.json({error:{message:'not supported'}},{status:404});
 });
 const list=()=>app(new Request('https://gateway/v1beta/models',{headers:{authorization:'Bearer sk-client'}}));
 assert.deepEqual(await (await list()).json(),{models:[{name:'models/gemini-good',displayName:'Keep'}],nextPageToken:'next'});
 assert.equal(probes.length,2);assert.equal(finishes.length,3);
 assert.ok(finishes.some(result=>result.p_input_tokens===3&&result.p_output_tokens===1));
 assert.ok(finishes.some(result=>result.p_status===404&&result.p_outcome==='failed'));
 assert.equal((await (await list()).json()).models.length,1);
 assert.equal(probes.length,2);assert.equal(finishes.length,4);
});

test('a model verification 429 cannot cool down the account and hide other working Gemini models',async()=>{
 const config={url:'https://db.invalid',serviceKey:'service',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
 const stored=await encryptCredentials({api_key:'provider-key'},config.encryptionKey);
 let cooldown=false;const finishes=[];
 const app=createBackendHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_acquire')){
   const args=JSON.parse(init.body);
   if(cooldown&&args.p_model!=='__models__')return Response.json({error:'no_available_account',status:503});
   return Response.json({lease_id:crypto.randomUUID(),account:{...stored,id:'account',type:'apikey',platform:'gemini',credential_version:1}});
  }
  if(String(url).endsWith('/s2a_personal_finish')){const result=JSON.parse(init.body);finishes.push(result);if(result.p_cooldown_seconds>0)cooldown=true;return Response.json({applied:true});}
  if(String(url).includes('/rpc/'))return Response.json(null);
  if(init.method==='GET')return Response.json({models:['gemini-limited-a','gemini-limited-b','gemini-good'].map(id=>({name:'models/'+id}))});
  return String(url).includes('gemini-good')?Response.json({candidates:[{content:{parts:[{text:'OK'}]}}]}):Response.json({error:{message:'Model quota exhausted'}},{status:429});
 });
 const response=await app(new Request('https://gateway/v1beta/models',{headers:{authorization:'Bearer sk-client'}}));
 assert.equal(response.status,200);
 assert.deepEqual((await response.json()).models.map(entry=>entry.name),['models/gemini-good']);
 assert.equal(cooldown,false);
 assert.ok(finishes.some(result=>result.p_status===429));
 assert.ok(finishes.every(result=>result.p_cooldown_seconds===0));
 // A public request cannot opt out of normal account cooldown with a header.
 await app(new Request('https://gateway/v1beta/models/gemini-limited-a:generateContent',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json','x-s2a-model-probe':'true'},body:JSON.stringify({contents:[{parts:[{text:'Hello'}]}]})}));
 assert.equal(cooldown,true);
 assert.ok(finishes.some(result=>result.p_status===429&&result.p_cooldown_seconds===60));
});

test('native Gemini catalogs verify every advertised model, including Claude and catalogs without Gemini-prefixed entries',async()=>{
 for(const models of [['gemini-good','claude-good','claude-unavailable','other-unavailable'],['claude-unavailable']]){
  const cache=new ModelAvailability();const checked=[];
  const result=await cache.filter(Response.json({models:models.map(id=>({name:'models/'+id})),nextPageToken:'next'}),request(),'key',true,async(req,path)=>{
   const model=decodeURIComponent(path.split('/').at(-1).split(':')[0]);checked.push(model);
   return model.endsWith('-good')?Response.json({candidates:[{content:{parts:[{text:'OK'}]}}]}):new Response(null,{status:404});
  });
  assert.deepEqual(checked.sort(),[...models].sort());
  assert.deepEqual((await result.json()).models.map(entry=>entry.name),models.filter(model=>model.endsWith('-good')).map(model=>'models/'+model));
 }
});

test('standard Gemini provider catalogs cannot bypass verification through Claude names or custom aliases',async()=>{
 const cache=new ModelAvailability();const checked=[];
 const result=await cache.filter(Response.json({data:[{id:'claude-unavailable',owned_by:'google'},{id:'custom-unavailable',owned_by:'google'},{id:'claude-independent',owned_by:'anthropic'}]}),request(),'key',false,async req=>{checked.push((await req.json()).model);return new Response(null,{status:404});});
 assert.deepEqual(checked.sort(),['claude-unavailable','custom-unavailable']);
 assert.deepEqual((await result.json()).data,[{id:'claude-independent',owned_by:'anthropic'}]);
});
