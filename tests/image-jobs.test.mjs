import {createHmac} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackendHandler} from './handler.mjs';
import {Database} from '../supabase/functions/sub2api/db.ts';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
import {executeImageJob,cleanupImageJobs} from '../supabase/functions/sub2api/image_jobs.ts';
import {storeImageResult,loadImageManifest} from '../supabase/functions/sub2api/image_task_result.ts';
import {hashKey} from '../supabase/functions/sub2api/validation.ts';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZxkAAAAASUVORK5CYII=';
const config={url:'https://project.supabase.co',serviceKey:'service-private',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
const lease='12345678-1234-1234-1234-123456789abc';
async function fixture(options={}){
 const objects=new Map(),calls=[],uploads=[],keyHash=await hashKey('sk-client'),stored=await encryptCredentials({api_key:'upstream-private'},config.encryptionKey);
 let task=null,job=null,providerCalls=0,startCalls=0,finishCalls=0;
 const view=()=>({id:task.id,task_id:task.id,object:'image.generation.task',status:task.status,created_at:1,expires_at:Math.floor(Date.now()/1000)+86400,...(task.status==='completed'?{result_path:'images/'+task.id+'/result.json',result_hash:task.hash,http_status:200}:{}),...(task.status==='failed'?{http_status:task.http_status,error:{type:'api_error',code:task.error,message:task.error}}:{})});
 const forward=async(url,init)=>{
  url=String(url);const headers=new Headers(init.headers);
  if(url.includes('/rest/v1/rpc/')){
   const name=url.split('/').at(-1),args=JSON.parse(init.body);calls.push({name,args});
   if(['s2a_log_write','s2a_ops_error_record'].includes(name))return Response.json(true);
   if(name==='s2a_personal_key_policy')return Response.json(args.p_key_hash===keyHash?{platform:'openai'}:{error:'invalid_api_key',status:401});
   if(name==='s2a_personal_image_task_prepare'){
    task={id:args.p_id,status:'processing'};job={id:args.p_id,lease_id:lease,recover:false,key_hash:args.p_key_hash,client_ip:args.p_client_ip,platform:'openai',model:args.p_model,operation:args.p_operation,content_type:args.p_content_type,body_hash:args.p_body_hash,body_size:args.p_body_size,request_path:'images/'+args.p_id+'/request.bin',result_path:'images/'+args.p_id+'/result.json'};return Response.json(view());
   }
   if(name==='s2a_personal_image_task_ready')return Response.json(view());
   if(name==='s2a_personal_image_task_read')return Response.json(!task?{error:'image_task_not_found',status:404}:args.p_key_hash!==keyHash?{error:'image_task_forbidden',status:403}:view());
   if(name==='s2a_personal_image_jobs_claim')return Response.json(job?[job]:[]);
   if(name==='s2a_personal_image_cleanup_claim'||name==='s2a_chat_media_expired')return Response.json([]);
   if(name==='s2a_personal_image_job_start'){
    startCalls++;if(options.startLost)throw Error('response lost');return Response.json({started:true});
   }
   if(name==='s2a_personal_image_job_finish'){
    finishCalls++;if(options.finishLost&&finishCalls===1)throw Error('response lost');
    task.status=args.p_http_status<300?'completed':'failed';task.hash=args.p_result_hash;task.error=args.p_error_code;task.http_status=args.p_http_status;return Response.json({applied:finishCalls===1});
   }
   if(name==='s2a_personal_acquire')return Response.json({lease_id:'inference-lease',upstream_model:'gpt-image-2',account:{...stored,id:'1',platform:'openai',type:'apikey',credential_version:1}});
   if(name==='s2a_personal_finish')return Response.json({applied:true});
   throw Error('Unexpected RPC '+name);
  }
  if(url.includes('/storage/v1/object/')){
   assert.equal(headers.get('authorization'),'Bearer service-private');
   if(url.includes('/object/sign/')){const path=url.split('/sub2api-artifacts/')[1];return Response.json({signedURL:'/object/sign/sub2api-artifacts/'+path+'?token=short-lived'});}
   const path=url.split('/sub2api-artifacts/')[1];
   if(init.method==='POST'){
    uploads.push(path);if(options.storageLost&&path.endsWith('result.json'))throw Error('Storage response lost');
    if(path.endsWith('request.bin'))assert.equal(headers.get('content-type'),'application/octet-stream');
    objects.set(path,new Uint8Array(init.body));return Response.json({});
   }
   return objects.has(path)?new Response(objects.get(path)):Response.json({statusCode:'404',error:'not_found'},{status:400});
  }
  providerCalls++;assert.equal(url,'https://api.openai.com/v1/images/generations');assert.equal(headers.get('authorization'),'Bearer upstream-private');
  if(options.providerError)return Response.json({error:{message:'private account info'}},{status:503});
  return Response.json({created:1,data:[{b64_json:png,revised_prompt:'A tree'}],usage:{input_tokens:2,output_tokens:3}});
 };
 const handler=createBackendHandler(config,forward),db=new Database(config,forward);
 const submit=async(path='/v1/images/generations/async')=>handler(new Request('https://gateway/functions/v1/sub2api'+path,{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify({prompt:'Tree',model:'image-alias'})}));
 return {objects,calls,uploads,handler,db,submit,get job(){return job;},get task(){return task;},get providerCalls(){return providerCalls;},get startCalls(){return startCalls;},get finishCalls(){return finishCalls;}};
}

test('cloud async image route stages, executes and polls private signed results using the same key',async()=>{
 for(const path of ['/v1/images/generations/async','/images/generations/async']){
  const f=await fixture(),response=await f.submit(path),submitted=await response.json();assert.equal(response.status,202);assert.equal(f.providerCalls,0);
  const poll=()=>f.handler(new Request(new URL(submitted.poll_url,'https://gateway'),{headers:{authorization:'Bearer sk-client'}}));
  const pending=await poll();assert.equal(pending.status,200);assert.equal(pending.headers.get('retry-after'),'3');assert.equal((await pending.json()).status,'processing');
  assert.equal(await executeImageJob(f.db,f.job),true);assert.equal(f.providerCalls,1);assert.equal(f.startCalls,1);
  const completed=await poll(),value=await completed.json();assert.equal(completed.status,200);assert.equal(completed.headers.get('retry-after'),null);assert.equal(completed.headers.get('cache-control'),'no-store');assert.equal(value.status,'completed');
  assert.equal(value.result.data[0].revised_prompt,'A tree');assert.match(value.image_url,/\/object\/sign\/sub2api-artifacts\/images\/imgtask_[a-f0-9]{32}\/image-1.png\?token=short-lived$/);
  assert.equal(value.result.data[0].url,value.image_url);assert.equal(value.result.data[0].b64_json,undefined);assert.equal(value.result.data[0].artifact_path,undefined);assert.equal(value.result_hash,undefined);assert.equal(value.result_path,undefined);assert.ok(!JSON.stringify(value).includes('private'));
  const denied=await f.handler(new Request(new URL(submitted.poll_url,'https://gateway'),{headers:{authorization:'Bearer sk-other'}}));assert.equal(denied.status,403);
 }
});

test('image scheduler rejects anonymous and cross-scope requests and admits service credentials',async()=>{
 const f=await fixture();
 assert.equal((await f.handler(new Request('https://gateway/internal/jobs/images',{method:'POST'}))).status,401);
 assert.equal((await f.handler(new Request('https://gateway/internal/jobs/images',{method:'GET',headers:{authorization:'Bearer service-private'}}))).status,405);
 const accepted=await f.handler(new Request('https://gateway/internal/jobs/images',{method:'POST',headers:{authorization:'Bearer service-private'}}));assert.equal(accepted.status,200);assert.deepEqual(await accepted.json(),{claimed:0,finished:0,cleaned:0});
});

test('request digest mismatch fails before dispatch and records a stable error',async()=>{
 const f=await fixture();await f.submit();f.objects.set(f.job.request_path,new TextEncoder().encode('corrupted'));
 assert.equal(await executeImageJob(f.db,f.job),true);assert.equal(f.startCalls,0);assert.equal(f.providerCalls,0);assert.equal(f.task.error,'image_task_invalid_input');
});

test('dispatched recovery finalizes saved manifests without any provider call',async()=>{
 const f=await fixture();await f.submit();
 const hash=await storeImageResult(f.db,f.job,Response.json({created:1,data:[{b64_json:png}]}),AbortSignal.timeout(1000));
 assert.equal(await executeImageJob(f.db,{...f.job,recover:true}),true);assert.equal(f.task.hash,hash);assert.equal(f.providerCalls,0);assert.equal(f.startCalls,0);
});

test('dispatched recovery without a valid manifest fails without regenerating',async()=>{
 for(const corrupt of [false,true]){
  const f=await fixture();await f.submit();if(corrupt)f.objects.set(f.job.result_path,new TextEncoder().encode('{invalid'));
  assert.equal(await executeImageJob(f.db,{...f.job,recover:true}),true);assert.equal(f.task.error,'image_task_execution_unknown');assert.equal(f.providerCalls,0);
 }
});

test('provider failure is stable and never retried by the image job',async()=>{
 const f=await fixture({providerError:true});await f.submit();assert.equal(await executeImageJob(f.db,f.job),true);assert.equal(f.providerCalls,1);assert.equal(f.task.error,'image_task_failed');assert.equal(f.uploads.length,1);
});

test('ambiguous start or result persistence remains recoverable and does not resubmit',async()=>{
 const start=await fixture({startLost:true});await start.submit();assert.equal(await executeImageJob(start.db,start.job),false);assert.equal(start.providerCalls,0);assert.equal(start.startCalls,2);
 const store=await fixture({storageLost:true});await store.submit();assert.equal(await executeImageJob(store.db,store.job),false);assert.equal(store.providerCalls,1);assert.equal(store.finishCalls,0);
 assert.equal(await executeImageJob(store.db,{...store.job,recover:true}),true);assert.equal(store.providerCalls,1);assert.equal(store.task.error,'image_task_execution_unknown');
 const finish=await fixture({finishLost:true});await finish.submit();assert.equal(await executeImageJob(finish.db,finish.job),true);assert.equal(finish.providerCalls,1);assert.equal(finish.finishCalls,2);
});

test('result manifests reject another task, foreign artifact paths, forged hashes and invalid images',async()=>{
 const f=await fixture();await f.submit();await storeImageResult(f.db,f.job,Response.json({data:[{b64_json:png}]}),AbortSignal.timeout(1000));
 const bytes=f.objects.get(f.job.result_path),value=JSON.parse(new TextDecoder().decode(bytes));
 await assert.rejects(loadImageManifest(f.db,f.job.id,AbortSignal.timeout(1000),{hash:'0'.repeat(64)}),/invalid_image_task_result/);
 for(const mutate of [copy=>copy.task_id='imgtask_'+'b'.repeat(32),copy=>copy.result.data[0].artifact_path='images/imgtask_'+'b'.repeat(32)+'/image-1.png',copy=>copy.result.data[0].url='https://unexpected.example',copy=>copy.result.data[0].b64_json='YQ==']){
  const copy=structuredClone(value);mutate(copy);f.objects.set(f.job.result_path,new TextEncoder().encode(JSON.stringify(copy)));await assert.rejects(loadImageManifest(f.db,f.job.id,AbortSignal.timeout(1000)),/invalid_image_task_result/);
 }
 await assert.rejects(storeImageResult(f.db,f.job,Response.json({data:[{b64_json:'YQ=='}]}),AbortSignal.timeout(1000)),/invalid_image_task_result/);
});

test('expired cleanup checks storage metadata before deleting the fenced database record',async()=>{
 const id='imgtask_'+'c'.repeat(32),paths=Array.from({length:100},(_,i)=>'image-'+(i+1)+'.png').concat(['request.bin','result.json']);let listed=0,finished=0;const deleted=[];
 const db={config,async rpc(name,args){if(name==='s2a_personal_image_cleanup_claim')return [{id,lease_id:lease}];assert.equal(name,'s2a_personal_image_cleanup_finish');assert.equal(args.p_id,id);finished++;return true;},async fetchImpl(url,init){
  if(url.endsWith('/object/list/sub2api-artifacts')){listed++;return Response.json(listed===1?paths.map(name=>({name})):[]);}
  assert.equal(init.method,'DELETE');deleted.push(JSON.parse(init.body).prefixes);return Response.json([]);
 }};
 assert.equal(await cleanupImageJobs(db),1);assert.equal(finished,1);assert.equal(listed,2);assert.deepEqual(deleted.map(batch=>batch.length),[100,2]);
});

test('OAuth data URLs and API-key URL results remain usable in asynchronous manifests',async()=>{
 const f=await fixture();await f.submit();
 await storeImageResult(f.db,f.job,Response.json({data:[{url:'data:image/png;base64,'+png}]}),AbortSignal.timeout(1000));
 let value=await loadImageManifest(f.db,f.job.id,AbortSignal.timeout(1000));assert.ok(value.manifest.result.data[0].artifact_path.endsWith('/image-1.png'));assert.equal(value.manifest.result.data[0].url,undefined);
 await storeImageResult(f.db,f.job,Response.json({data:[{url:'https://images.example/generated.png?token=provider-result'}]}),AbortSignal.timeout(1000));
 value=await loadImageManifest(f.db,f.job.id,AbortSignal.timeout(1000));assert.equal(value.manifest.result.data[0].url,'https://images.example/generated.png?token=provider-result');
 for(const url of ['http://images.example/file','https://secret@images.example/file','data:image/png;base64,invalid'])await assert.rejects(storeImageResult(f.db,f.job,Response.json({data:[{url}]}),AbortSignal.timeout(1000)),/invalid_image_task_result/);
});

test('image job tickets use the derived signing key, exact scope and ninety-second window',async()=>{
 const signingKey='a'.repeat(64),now=Math.floor(Date.now()/1000),nonce=crypto.randomUUID();let claims=0;
 const handler=createBackendHandler({...config,jobSigningKey:signingKey},async(url)=>{claims++;return Response.json([]);});
 const ticket=(expiry,scope='images',key=signingKey)=>`${expiry}:${nonce}:${createHmac('sha256',key).update(`s2a-${scope}:${expiry}:${nonce}`).digest('hex')}`;
 for(const value of [ticket(now-1),ticket(now+100),ticket(now+60,'gemini-cache'),ticket(now+60,'images',config.serviceKey)]){
  assert.equal((await handler(new Request('https://gateway/internal/jobs/images',{method:'POST',headers:{'x-s2a-images-job-token':value}}))).status,401);
 }
 assert.equal(claims,0);
 assert.equal((await handler(new Request('https://gateway/internal/jobs/images',{method:'POST',headers:{'x-s2a-images-job-token':ticket(now+60)}}))).status,200);assert.equal(claims,3);
 assert.equal((await handler(new Request('https://gateway/v1/images/tasks/imgtask_'+'a'.repeat(32),{headers:{'x-s2a-images-job-token':ticket(now+60)}}))).status,401);
});
