import test from 'node:test';
import assert from 'node:assert/strict';
import {Database} from '../supabase/functions/sub2api/db.ts';
import {storeBatchRequest} from '../supabase/functions/sub2api/batch_image_storage.ts';
import {runBatchImageJobs} from '../supabase/functions/sub2api/batch_image_runner.ts';
const id='imgbatch_'+'a'.repeat(32),lease='11111111-1111-1111-1111-111111111111';
test('batch runner connects native admission, private request and receipt storage to real Gemini transport',async()=>{
 const files=new Map(),calls=[];let hash;
 const db=new Database({url:'https://db.invalid',serviceKey:'service',dataModel:'native'},async(url,init)=>{
  const value=String(url);calls.push(value);
  if(value.includes('/rest/v1/rpc/')){
   const name=value.split('/').at(-1);if(name.endsWith('_claim'))return Response.json([{batch_id:id,lease_id:lease,stage:'upload',recover_create:false}]);
   if(name.endsWith('_admit'))return Response.json({provider:'gemini_api',model:'gemini-image',request_hash:hash,account:{id:'1',platform:'gemini',type:'apikey',credential_storage:'vault',credential_version:1,credentials:{api_key:'provider-token',model_mapping:{'gemini-image':'gemini-3.1-flash-image'}}}});
   return Response.json(name.endsWith('_dispatch')?{dispatched:true}:{applied:true});
  }
  if(value.startsWith('https://generativelanguage.googleapis.com')){
   assert.equal(new Headers(init.headers).get('x-goog-api-key'),'provider-token');if(!value.includes('/upload/'))assert.ok(value.endsWith('/models/gemini-3.1-flash-image:batchGenerateContent'));return Response.json(value.includes('/upload/')?{file:{name:'files/uploaded'}}:{name:'batches/created',state:'JOB_STATE_PENDING'});
  }
  const path=new URL(url).pathname.replace('/object/authenticated/','/object/');if(init.method==='POST'){files.set(path,new Uint8Array(init.body));return Response.json({});}return new Response(files.get(path));
 });
 hash=(await storeBatchRequest(db,id,{model:'gemini-image',items:[{prompt:'blue square'}]},AbortSignal.timeout(5000))).requestHash;
 assert.deepEqual(await runBatchImageJobs(db,{index:()=>assert.fail('premature index')}),{claimed:1,processed:1});
 const created=[...files.entries()].find(([path])=>path.endsWith('created.json'));assert.equal(JSON.parse(new TextDecoder().decode(created[1])).name,'batches/created');assert.ok(calls.findIndex(value=>value.endsWith('_admit'))<calls.findIndex(value=>value.includes('generativelanguage')));
});
test('batch runner fails revoked admission without fetching provider credentials or submitting inference',async()=>{
 const calls=[],db=new Database({url:'https://db.invalid',serviceKey:'service',dataModel:'native'},async(url)=>{const name=String(url).split('/').at(-1);calls.push(name);return Response.json(name.endsWith('_claim')?[{batch_id:id,lease_id:lease,stage:'upload',recover_create:false}]:name.endsWith('_admit')?{error:'batch_image_identity_changed',status:403}:{applied:true});});
 assert.deepEqual(await runBatchImageJobs(db,{index:()=>assert.fail('index')}),{claimed:1,processed:1});assert.deepEqual(calls,['s2a_batch_image_runtime_claim','s2a_batch_image_runtime_admit','s2a_batch_image_runtime_fail']);
});
