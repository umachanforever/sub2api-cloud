import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelAvailability} from '../supabase/functions/sub2api/model_availability.ts';
const request=()=>new Request('https://gateway/v1/models',{headers:{authorization:'Bearer client','x-real-ip':'192.0.2.1'}});
const listing=()=>Response.json({data:[{id:'gpt-custom'},{id:'gemini-good',extension:42},{id:'gemini-bad'},{id:'gemini-*'}],nextPageToken:'opaque',extension:true},{headers:{etag:'"unfiltered"','last-modified':'yesterday'}});
const success=()=>Response.json({choices:[{finish_reason:'stop',message:{content:'OK'}}]});

test('only successful Gemini inference survives while other providers, metadata and pagination remain intact',async()=>{
 const cache=new ModelAvailability();const calls=[];
 const result=await cache.filter(listing(),request(),'key',false,async(req,path)=>{
  const body=await req.json();calls.push(body.model);
  assert.equal(path,'/v1/chat/completions');assert.equal(body.max_tokens,1024);assert.equal(body.stream,false);
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
  const payload=await req.json();assert.equal(payload.generationConfig.maxOutputTokens,1024);assert.ok(payload.contents.length);
  if(path.includes('gemini-good'))return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'OK'}]}}]});
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

test('native Gemini catalogs verify every advertised model, including Claude and catalogs without Gemini-prefixed entries',async()=>{
 for(const models of [['gemini-good','claude-good','claude-unavailable','other-unavailable'],['claude-unavailable']]){
  const cache=new ModelAvailability();const checked=[];
  const result=await cache.filter(Response.json({models:models.map(id=>({name:'models/'+id})),nextPageToken:'next'}),request(),'key',true,async(req,path)=>{
   const model=decodeURIComponent(path.split('/').at(-1).split(':')[0]);checked.push(model);
   return model.endsWith('-good')?Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'OK'}]}}]}):new Response(null,{status:404});
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

test('empty, reasoning-only and token-truncated successes do not prove a usable model',async()=>{
 for(const native of [true,false]){
 const result=await new ModelAvailability().filter(Response.json({data:['good','empty','truncated','thinking'].map(x=>({id:'gemini-'+x}))}),request(),'key',native,async(req,path)=>{
 const model=native?path:(await req.json()).model;
 const reason=model.includes('truncated')?(native?'MAX_TOKENS':'length'):(native?'STOP':'stop');
 const text=model.includes('empty')?'':'OK';
 return Response.json(native?{candidates:[{finishReason:reason,content:{parts:[{text,...(model.includes('thinking')?{thought:true}:{})}]}}]}:{choices:[{finish_reason:reason,message:model.includes('thinking')?{reasoning_content:text}:{content:text}}]});
 });
 assert.deepEqual((await result.json()).data.map(x=>x.id),['gemini-good']);
 }
});

test('listing deadlines keep prior successes and rotate unverified models without caching cancellation as unsupported',async()=>{
 const cache=new ModelAvailability(Date.now,{listing:60,probe:50});
 const entries=['gemini-good','gemini-slow-a','gemini-slow-b','gemini-slow-c','gemini-slow-d','gemini-later'];
 const calls=[];let pass=0;
 const run=()=>cache.filter(Response.json({data:entries.map(id=>({id}))}),request(),'scope',false,async req=>{
 const {model}=await req.json();calls.push(model);
 if(pass===0&&model.includes('slow'))await new Promise((resolve,reject)=>{
 const timer=setTimeout(resolve,1000);req.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(req.signal.reason);},{once:true});
 });
 return success();
 });
 const first=await run();assert.ok((await first.json()).data.some(x=>x.id==='gemini-good'));assert.ok(!calls.includes('gemini-later'));
 pass++;const second=await run();assert.ok((await second.json()).data.some(x=>x.id==='gemini-later'));
 assert.match(second.headers.get('x-s2a-model-verification'),/unsupported=0/);
 assert.equal(calls.filter(x=>x==='gemini-good').length,1);
});
