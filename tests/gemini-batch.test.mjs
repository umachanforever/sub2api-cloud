import test from 'node:test';
import assert from 'node:assert/strict';
import {Database} from '../supabase/functions/sub2api/db.ts';
import {GeminiBatchClient,GeminiBatchRequestError,buildGeminiBatchJSONL,geminiBatchStatus} from '../supabase/functions/sub2api/gemini_batch.ts';
const origin='https://generativelanguage.googleapis.com',account={id:'1',platform:'gemini',type:'apikey',credential_version:1},credentials={api_key:'provider-private'};
const signal=()=>AbortSignal.timeout(5000);
function client(forward,options){return new GeminiBatchClient(new Database({url:'https://db.invalid',serviceKey:'service'},forward),account,credentials,options);}
const input={model:'gemini-3.1-flash-image',items:[{custom_id:' first ',prompt:' A blue square\nwith 中文 ',reference_images:[{mime_type:'image/jpg',data:'YQ=='},{mime_type:'image/webp',file_uri:'gs://bucket/style.webp'}]},{custom_id:'second',prompt:'A green square'}]};

test('Gemini batch JSONL preserves request keys, Unicode, prompt boundaries and reference images',()=>{
 const bytes=buildGeminiBatchJSONL(input),source=new TextDecoder().decode(bytes),lines=source.trim().split('\n').map(JSON.parse);
 assert.equal(lines.length,2);assert.ok(source.endsWith('\n'));assert.equal(lines[0].key,'first');assert.equal(lines[0].request.contents[0].parts[0].text,'A blue square\nwith 中文');assert.deepEqual(lines[0].request.contents[0].parts.slice(1),[{inlineData:{mimeType:'image/jpeg',data:'YQ=='}},{fileData:{mimeType:'image/webp',fileUri:'gs://bucket/style.webp'}}]);assert.deepEqual(lines[0].request.generationConfig,{responseModalities:['TEXT','IMAGE']});assert.equal(input.items[0].custom_id,' first ');
});

test('invalid and duplicate batch items or ambiguous references fail before upload',()=>{
 for(const value of [{model:'',items:input.items},{model:'../model',items:input.items},{model:input.model,items:[]},{model:input.model,items:[{custom_id:'a',prompt:' '} ]},{model:input.model,items:[{custom_id:'a',prompt:'one'},{custom_id:' a ',prompt:'two'}]}])assert.throws(()=>buildGeminiBatchJSONL(value),error=>error.status===400);
 for(const ref of [{mime_type:'image/png'},{mime_type:'image/png',data:'YQ==',file_uri:'gs://bucket/key'},{mime_type:'text/plain',data:'YQ=='},{mime_type:'image/png',data:'invalid!'},{mime_type:'image/png',file_uri:'https://evil.example/image'},{mime_type:'image/png',file_uri:'gs://bucket/key\r\nother'}])assert.throws(()=>buildGeminiBatchJSONL({model:input.model,items:[{custom_id:'a',prompt:'one',reference_images:[ref]}]}),/invalid_batch_reference/);
});

test('batch upload and creation are separate authenticated operations with original Gemini REST envelopes',async()=>{
 const calls=[],bytes=buildGeminiBatchJSONL(input),instance=client(async(url,init)=>{
  calls.push(String(url));const headers=new Headers(init.headers);assert.equal(headers.get('x-goog-api-key'),'provider-private');assert.equal(headers.get('authorization'),null);assert.equal(init.redirect,'error');assert.ok(!String(url).includes('provider-private'));
  if(calls.length===1){
   assert.equal(String(url),origin+'/upload/v1beta/files?uploadType=multipart');
   const form=await new Response(init.body,{headers}).formData();assert.deepEqual(JSON.parse(form.get('metadata')),{file:{displayName:'imgbatch-owned',mimeType:'application/jsonl'}});assert.equal(form.get('file').name,'batch.jsonl');assert.deepEqual(new Uint8Array(await form.get('file').arrayBuffer()),bytes);return Response.json({file:{name:'files/uploaded'}});
  }
  assert.equal(String(url),origin+'/v1beta/models/gemini-3.1-flash-image:batchGenerateContent');assert.deepEqual(JSON.parse(init.body),{batch:{displayName:'imgbatch-owned',inputConfig:{fileName:'files/uploaded'}}});return Response.json({name:'batches/job-1',state:'JOB_STATE_PENDING'});
 });
 assert.ok(!JSON.stringify(instance).includes('provider-private'));assert.ok(!JSON.stringify(instance).includes('service'));
 const file=await instance.uploadJSONL(bytes,'imgbatch-owned',signal());assert.equal(file,'files/uploaded');assert.equal(calls.length,1);
 const batch=await instance.createBatch(input.model,file,'imgbatch-owned',signal());assert.equal(batch.name,'batches/job-1');assert.equal(batch.status,'queued');assert.equal(batch.done,false);assert.equal(calls.length,2);
});

test('batch state mapping retains queued, running and terminal states and result file aliases',()=>{
 for(const [raw,state,done] of [['JOB_STATE_QUEUED','queued',false],['JOB_STATE_RUNNING','running',false],['JOB_STATE_FAILED','failed',true],['JOB_STATE_CANCELLED','cancelled',true],['JOB_STATE_EXPIRED','expired',true],['FUTURE_STATE','running',false]]){
  const value=geminiBatchStatus({name:'batches/1',state:raw});assert.equal(value.status,state);assert.equal(value.done,done);assert.equal(value.requeue_after_seconds,30);
 }
 for(const extra of [{dest:{fileName:'files/output'}},{dest:{file_name:'files/output'}},{response:{responsesFile:'files/output'}},{response:{responses_file:'files/output'}}])assert.equal(geminiBatchStatus({name:'batches/1',state:'JOB_STATE_SUCCEEDED',...extra}).output_ref,'files/output');
 assert.equal(geminiBatchStatus({name:'batches/1',state:'JOB_STATE_SUCCEEDED'}).error_code,'GEMINI_RESULT_FILE_MISSING');
 assert.throws(()=>geminiBatchStatus({name:'batches/1',state:'JOB_STATE_SUCCEEDED',response:{inlinedResponses:[{response:'large'}]}}),/gemini_batch_inline_result_unsupported/);
 assert.equal(geminiBatchStatus({name:'batches/1',state:'FUTURE_STATE',error:{code:'PRIVATE',message:'provider-private'}}).status,'failed');assert.ok(!JSON.stringify(geminiBatchStatus({name:'batches/1',state:'JOB_STATE_FAILED',error:{message:'provider-private'}})).includes('provider-private'));
});

test('get, cancel and cleanup use validated provider resources and make deletion idempotent',async()=>{
 const seen=[],instance=client(async(url,init)=>{seen.push([String(url),init.method]);if(init.method==='GET')return Response.json({name:'batches/job-1',state:'JOB_STATE_RUNNING'});return new Response(null,{status:init.method==='DELETE'?404:204});});
 assert.equal((await instance.getBatch('batches/job-1',signal())).status,'running');await instance.cancelBatch('batches/job-1',signal());await instance.deleteFile('files/uploaded',signal());
 assert.deepEqual(seen,[[origin+'/v1beta/batches/job-1','GET'],[origin+'/v1beta/batches/job-1:cancel','POST'],[origin+'/v1beta/files/uploaded','DELETE']]);
 const untouched=client(()=>assert.fail('Invalid resource reached network'));
 for(const name of ['../private','files/../x','files/..','files/abc?key=secret','https://evil.example/file'])await assert.rejects(untouched.deleteFile(name,signal()),/invalid_gemini_batch_resource/);
 await assert.rejects(client(async()=>Response.json({name:'batches/other',state:'JOB_STATE_RUNNING'})).getBatch('batches/owned',signal()),/invalid_gemini_batch_response/);
});

test('uncertain uploads and batch creations are not retried or mistaken for definitive rejection',async()=>{
 for(const kind of ['network','http500','malformed','missing-name']){
  let calls=0;const instance=client(async()=>{calls++;if(kind==='network')throw Error('private network details');if(kind==='http500')return Response.json({error:{message:'provider-private'}},{status:500});if(kind==='malformed')return new Response('invalid');return Response.json({state:'JOB_STATE_PENDING'});});
  await assert.rejects(instance.createBatch(input.model,'files/input','owned',signal()),error=>error instanceof GeminiBatchRequestError&&error.uncertain&&!error.message.includes('private'));assert.equal(calls,1);
 }
 let calls=0;const denied=client(async()=>{calls++;return Response.json({error:{message:'provider-private'}},{status:429});});
 await assert.rejects(denied.uploadJSONL(buildGeminiBatchJSONL(input),'owned',signal()),error=>error.status===502&&error.upstreamStatus===429&&error.uncertain===false&&error.code==='gemini_batch_rate_limited');assert.equal(calls,1);
});

test('batch result metadata supports official download links and fallback without buffering JSONL',async()=>{
 for(const metadata of [{downloadUri:'https://storage.googleapis.com/bucket/out?alt=media'},{download_url:origin+'/download/v1beta/files/out:download'},{downloadUri:'',mimeType:'application/jsonl'}]){
  let calls=0;const abort=new AbortController();const instance=client(async(url,init)=>{calls++;assert.equal(init.signal,abort.signal);assert.equal(new Headers(init.headers).get('x-goog-api-key'),'provider-private');assert.equal(init.redirect,'error');if(calls===1)return Response.json(metadata);assert.equal(String(url),metadata.downloadUri||metadata.download_url||origin+'/v1beta/files/output:download');return new Response('line-one\nline-two\n',{headers:{'content-type':'application/jsonl'}});});
  const response=await instance.downloadFile('files/output',abort.signal);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('content-type'),'application/jsonl');assert.equal(await response.text(),'line-one\nline-two\n');assert.equal(calls,2);
 }
});

test('result metadata cannot redirect provider credentials to non-Google hosts, alternate ports or userinfo',async()=>{
 for(const downloadUri of ['https://evil.example/key','http://storage.googleapis.com/out','https://storage.googleapis.com.evil.example/out','https://user:secret@storage.googleapis.com/out','https://storage.googleapis.com:444/out','https://storage.googleapis.com/out#secret']){
  let calls=0;const instance=client(async()=>{calls++;return Response.json({downloadUri});});await assert.rejects(instance.downloadFile('files/output',signal()),/invalid_gemini_batch_download/);assert.equal(calls,1);
 }
 let calls=0;const instance=client(async()=>{calls++;return calls===1?Response.json({}):new Response('large',{headers:{'content-length':String(256*1024*1024+1)}});},{maxResultBytes:256*1024*1024});await assert.rejects(instance.downloadFile('files/output',signal()),/batch_result_too_large/);
});

test('metadata bounds and account validation prevent unintended provider requests',async()=>{
 const db=new Database({url:'https://db.invalid',serviceKey:'private'},()=>assert.fail('Invalid account reached network'));
 for(const candidate of [{...account,platform:'openai'},{...account,type:'oauth'}])assert.throws(()=>new GeminiBatchClient(db,candidate,credentials),/batch_provider_account_unsupported/);
 assert.throws(()=>new GeminiBatchClient(db,account,{api_key:'secret',base_url:'https://evil.example'}),/custom_base_url_unsupported/);
 await assert.rejects(client(async()=>new Response('x'.repeat(1024*1024+1))).getBatch('batches/owned',signal()),/invalid_gemini_batch_response/);
});


test('provider status retains bounded error codes while rejecting malformed nested response shapes',()=>{
 assert.equal(geminiBatchStatus({name:'batches/1',state:'JOB_STATE_FAILED',error:{code:'BAD_PROMPT',message:'private prompt'}}).error_code,'BAD_PROMPT');
 assert.equal(geminiBatchStatus({name:'batches/1',state:'JOB_STATE_FAILED',error:{code:'api-key-secret'}}).error_code,'GEMINI_BATCH_FAILED');
 for(const extra of [{state:1},{error:'unexpected'},{dest:[]},{response:'unexpected'},{state:'JOB_STATE_SUCCEEDED',response:{inlinedResponses:{malformed:true}}}])assert.throws(()=>geminiBatchStatus({name:'batches/1',state:'JOB_STATE_RUNNING',...extra}),/invalid_gemini_batch_response/);
});


test('default batch downloads remain streamed without a new total-size cap; optional limits count actual bytes',async()=>{
 let calls=0;const unlimited=client(async()=>{calls++;return calls===1?Response.json({}):new Response('streamed',{headers:{'content-length':String(1024*1024*1024)}});});assert.equal(await (await unlimited.downloadFile('files/output',signal())).text(),'streamed');
 calls=0;const limited=client(async()=>{calls++;return calls===1?Response.json({}):new Response('long-result',{headers:{'content-length':'1'}});},{maxResultBytes:4});
 const response=await limited.downloadFile('files/output',signal());await assert.rejects(response.text(),/batch_result_too_large/);
});
