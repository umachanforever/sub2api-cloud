import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyImageTasks} from '../scripts/verify-image-tasks.mjs';
const api='https://project.supabase.co/functions/v1/sub2api/v1',config={base_url:api,api_key:'sk-client'};
function fixture({foreignPoll=false,foreignImage=false,failed=false}={}){
 let submits=0,downloads=0,polls=0;const calls=[];
 return {calls,get submits(){return submits;},get downloads(){return downloads;},async fetcher(url,init={}){
  const headers=new Headers(init.headers);calls.push({url,headers,body:init.body});
  if(url.endsWith('/async')){
   submits++;assert.equal(headers.get('authorization'),'Bearer sk-client');
   if(url.includes('/edits/')){assert.ok(init.body instanceof FormData);assert.equal(init.body.get('image').size,3);}else assert.equal(JSON.parse(init.body).model,'gpt-image-2');
   const id='imgtask_'+String(submits).repeat(32),poll_url=(foreignPoll?'https://foreign.invalid':api)+'/images/tasks/'+id;
   return Response.json({id,task_id:id,status:'processing',poll_url},{status:202,headers:{location:poll_url,'cache-control':'no-store'}});
  }
  if(url.includes('/images/tasks/')){
   if(!headers.has('authorization'))return new Response(null,{status:401});
   assert.equal(headers.get('authorization'),'Bearer sk-client');polls++;
   const id=url.split('/').at(-1),image_url=(foreignImage?'https://foreign.invalid':'https://project.supabase.co')+'/storage/v1/object/sign/sub2api-artifacts/images/'+id+'/image-1.png?token=short-lived';
   if(failed)return Response.json({id,status:'failed',error:{code:'image_task_execution_unknown'}},{headers:{'cache-control':'no-store'}});
   if(polls%2)return Response.json({id,status:'processing'},{headers:{'cache-control':'no-store','retry-after':'3'}});
   return Response.json({id,status:'completed',image_url,result:{data:[{url:image_url}]}},{headers:{'cache-control':'no-store'}});
  }
  assert.ok(url.startsWith('https://project.supabase.co/storage/v1/'));assert.equal(headers.get('authorization'),null);downloads++;return new Response(Uint8Array.of(1,2,3),{headers:{'content-type':'image/png'}});
 }};
}

test('image acceptance verifies generation, private polling, signed download and multipart edits',async()=>{
 const f=fixture();assert.deepEqual(await verifyImageTasks({...config,verify_edits:true},f.fetcher,async()=>{}),['async-generation','authenticated-polling','private-signed-download','async-multipart-edit']);assert.equal(f.submits,2);assert.equal(f.downloads,2);
});

test('image acceptance never forwards its key to substituted poll or artifact destinations',async()=>{
 for(const options of [{foreignPoll:true},{foreignImage:true}]){
  const f=fixture(options);await assert.rejects(verifyImageTasks(config,f.fetcher,async()=>{}),/Invalid/);assert.ok(f.calls.every(call=>!call.url.startsWith('https://foreign.invalid')));assert.equal(f.downloads,0);
 }
});

test('image acceptance reports terminal execution ambiguity without another submit',async()=>{
 const f=fixture({failed:true});await assert.rejects(verifyImageTasks(config,f.fetcher,async()=>{}),/image_task_execution_unknown/);assert.equal(f.submits,1);
});
