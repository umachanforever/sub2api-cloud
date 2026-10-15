import test from 'node:test';
import assert from 'node:assert/strict';
import {imageTaskSubmit,ImageTaskSubmitError,imageBytesHash,checkImageTask} from '../supabase/functions/sub2api/image_task_submit.ts';
import {HttpError} from '../supabase/functions/sub2api/db.ts';
import {hashKey} from '../supabase/functions/sub2api/validation.ts';
function fixture({platform='openai',rpcFailure,uploadFailure,limits}={}){
 const calls=[],uploads=[];
 const db={config:{url:'https://project.supabase.co',serviceKey:'private',dataModel:'native',requestLimits:limits},
  async rpc(name,args){
   calls.push({name,args});if(name==='s2a_personal_key_policy')return {platform};
   const failure=rpcFailure?.(name,args,calls.filter(call=>call.name===name).length);if(failure)throw failure;
   return {id:args.p_id,task_id:args.p_id,object:'image.generation.task',status:'processing',created_at:1,expires_at:86401,result_path:'private',result_hash:'private'};
  },async fetchImpl(url,init){
   uploads.push({url,init});return uploadFailure?.(uploads.length)??Response.json({});
  }};
 return {db,calls,uploads};
}
function request(body={prompt:'Draw a tree'},headers={}){return new Request('https://gateway/functions/v1/sub2api/v1/images/generations/async?key=discard',{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':'192.0.2.2, 192.0.2.3',...headers},body:JSON.stringify(body)});}

test('async image submission freezes owner, content digest and exact private bytes before ready',async()=>{
 const f=fixture(),req=request({prompt:'Tree',custom:'preserved'}),bytes=new Uint8Array(await req.clone().arrayBuffer());
 const response=await imageTaskSubmit(req,'generations','sk-client',f.db),value=await response.json();
 assert.equal(response.status,202);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('retry-after'),'3');
 assert.match(value.id,/^imgtask_[a-f0-9]{32}$/);assert.equal(value.poll_url,'/functions/v1/sub2api/v1/images/tasks/'+value.id);assert.equal(response.headers.get('location'),value.poll_url);
 assert.equal(value.result_path,undefined);assert.equal(value.result_hash,undefined);
 assert.deepEqual(f.calls.map(call=>call.name),['s2a_personal_key_policy','s2a_personal_image_task_prepare','s2a_personal_image_task_ready']);
 const args=f.calls[1].args;assert.equal(args.p_key_hash,await hashKey('sk-client'));assert.equal(args.p_client_ip,'192.0.2.2');assert.equal(args.p_model,'gpt-image-2');assert.equal(args.p_body_hash,await imageBytesHash(bytes));assert.equal(args.p_body_size,bytes.length);
 assert.deepEqual(f.uploads[0].init.body,bytes);assert.ok(f.uploads[0].url.endsWith('/images/'+value.id+'/request.bin'));
 assert.ok(!JSON.stringify(f.calls).includes('sk-client'));
});

test('multipart staging preserves original boundaries, filenames and binary uploads',async()=>{
 const f=fixture(),form=new FormData();form.set('model','image-alias');form.set('prompt','Edit');form.set('stream','false');form.append('image[]',new Blob([Uint8Array.of(0,255,1)],{type:'image/png'}),'input.png');
 const req=new Request('https://gateway/images/edits/async',{method:'POST',body:form}),bytes=new Uint8Array(await req.clone().arrayBuffer()),contentType=req.headers.get('content-type');
 assert.equal((await imageTaskSubmit(req,'edits','sk-client',f.db)).status,202);
 assert.deepEqual(f.uploads[0].init.body,bytes);assert.equal(new Headers(f.uploads[0].init.headers).get('content-type'),'application/octet-stream');assert.equal(f.calls[1].args.p_content_type,contentType);assert.equal(f.calls[1].args.p_operation,'edits');
});

test('malformed, streaming and missing edit inputs never persist jobs or artifacts',async()=>{
 for(const body of [{prompt:'Tree',stream:true},{prompt:'Tree',stream:'false'},{prompt:''},{prompt:'Tree',model:'__models__'},{prompt:'Tree',model:'a/b'}]){
  const f=fixture();await assert.rejects(imageTaskSubmit(request(body),'generations','sk-client',f.db),error=>error.status===400);assert.equal(f.calls.length,1);assert.equal(f.uploads.length,0);
 }
 const f=fixture();await assert.rejects(imageTaskSubmit(request(),'edits','sk-client',f.db),/image_input_required/);assert.equal(f.calls.length,1);
});

test('Grok requires an explicit model and preserves quality alias for database policy validation',async()=>{
 const f=fixture({platform:'grok'});await assert.rejects(imageTaskSubmit(request(),'generations','sk-client',f.db),/image_model_required/);
 await imageTaskSubmit(request({prompt:'Tree',model:'grok-imagine'}),'generations','sk-client',f.db);assert.equal(f.calls[2].args.p_model,'grok-imagine');
 const other=fixture({platform:'gemini'});await assert.rejects(imageTaskSubmit(request(),'generations','sk-client',other.db),/image_platform_unsupported/);assert.equal(other.uploads.length,0);
});

test('wire limits use actual bytes despite an understated content length',async()=>{
 const f=fixture({limits:{server:20,gateway:20,text:20}});await assert.rejects(imageTaskSubmit(request({prompt:'a'.repeat(30)},{'content-length':'1'}),'generations','sk-client',f.db),error=>error.status===413);assert.equal(f.calls.length,1);assert.equal(f.uploads.length,0);
});

test('response-loss retries preserve the task identity and never acquire an inference account',async()=>{
 const f=fixture({rpcFailure:(name,args,count)=>name!=='s2a_personal_key_policy'&&count===1?new HttpError(503,'database_unavailable'):null,uploadFailure:count=>count===1?new Response('lost',{status:503}):null});
 const value=await (await imageTaskSubmit(request(),'generations','sk-client',f.db)).json();
 assert.equal(f.uploads.length,2);assert.equal(f.calls.length,5);for(const call of f.calls.slice(1))assert.equal(call.args.p_id,value.id);assert.equal(f.uploads[0].url,f.uploads[1].url);
});

test('ambiguous persistence failures preserve a recoverable public task identifier',async()=>{
 const f=fixture({rpcFailure:name=>name==='s2a_personal_image_task_ready'?new HttpError(503,'database_unavailable'):null});
 await assert.rejects(imageTaskSubmit(request(),'generations','sk-client',f.db),error=>error instanceof ImageTaskSubmitError&&error.status===503&&/^imgtask_[a-f0-9]{32}$/.test(error.taskId));assert.equal(f.uploads.length,1);
 const denied=fixture();denied.db.rpc=async name=>name==='s2a_personal_key_policy'?{platform:'openai'}:{error:'model_not_allowed',status:403};
 await assert.rejects(imageTaskSubmit(request(),'generations','sk-client',denied.db),error=>error.status===403);assert.equal(denied.uploads.length,0);
});

test('failed task objects are distinct from RPC error envelopes',()=>{
 const id='imgtask_'+'a'.repeat(32),task={id,task_id:id,object:'image.generation.task',status:'failed',created_at:1,expires_at:2,error:{code:'image_task_failed'}};
 assert.deepEqual(checkImageTask(task,id),task);assert.throws(()=>checkImageTask({error:'image_task_forbidden',status:403},id),error=>error.status===403);assert.throws(()=>checkImageTask({...task,id:'other'},id),/invalid_image_task_response/);
});

test('key admission fails before consuming or storing an uploaded request',async()=>{
 const f=fixture();let consumed=false;
 f.db.rpc=async()=>({error:'invalid_api_key',status:401});
 const body=new ReadableStream({pull(controller){consumed=true;controller.enqueue(new Uint8Array([1]));controller.close();}},{highWaterMark:0});
 const req=new Request('https://gateway/images/edits/async',{method:'POST',headers:{'content-type':'multipart/form-data; boundary=x'},body,duplex:'half'});
 await assert.rejects(imageTaskSubmit(req,'edits','sk-invalid',f.db),error=>error.status===401);assert.equal(consumed,false);assert.equal(f.uploads.length,0);await req.body.cancel();
});

test('unsupported content types and storage quota failures never mark tasks ready',async()=>{
 const unsupported=fixture();await assert.rejects(imageTaskSubmit(request({prompt:'Tree'},{'content-type':'text/plain'}),'generations','sk-client',unsupported.db),error=>error.status===415);assert.equal(unsupported.calls.length,1);
 const quota=fixture({uploadFailure:()=>new Response('limit',{status:413})});await assert.rejects(imageTaskSubmit(request(),'generations','sk-client',quota.db),error=>error instanceof ImageTaskSubmitError&&error.status===413);assert.equal(quota.uploads.length,1);assert.equal(quota.calls.filter(call=>call.name==='s2a_personal_image_task_ready').length,0);
});

test('Supabase internal request origins never escape into public polling locations',async()=>{
 for(const path of ['/sub2api/v1/images/generations/async','/functions/v1/sub2api/v1/images/generations/async']){
  const f=fixture(),req=new Request('http://edge-runtime:9000'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:'Tree'})});
  const response=await imageTaskSubmit(req,'generations','sk-client',f.db),value=await response.json();assert.equal(value.poll_url,'/functions/v1/sub2api/v1/images/tasks/'+value.id);assert.equal(response.headers.get('location'),value.poll_url);assert.ok(!JSON.stringify(value).includes('edge-runtime'));
 }
});
