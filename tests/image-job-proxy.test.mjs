import test from 'node:test';
import assert from 'node:assert/strict';
import {proxyImageJob,proxy} from '../supabase/functions/sub2api/proxy.ts';
import {Database} from '../supabase/functions/sub2api/db.ts';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
import {hashKey} from '../supabase/functions/sub2api/validation.ts';
const config={url:'https://database.invalid',serviceKey:'private',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
const job={id:'imgtask_'+'a'.repeat(32),lease_id:'12345678-1234-1234-1234-123456789abc',key_hash:'b'.repeat(64),client_ip:'192.0.2.1',platform:'openai',model:'image-alias',operation:'generations'};
function request(body={model:'image-alias',prompt:'Tree'}){return new Request('https://worker.internal',{method:'POST',headers:{'content-type':'application/json','x-real-ip':'198.51.100.9','x-s2a-image-job-lease':'forged'},body:JSON.stringify(body)});}
function context(){return {requestId:crypto.randomUUID(),started:Date.now()};}
async function fixture({upstreamStatus=200,platform='openai',admissionError}={}){
 const stored=await encryptCredentials({api_key:'provider-key'},config.encryptionKey),acquires=[],finishes=[];let providerCalls=0;
 const db=new Database(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_acquire')){
   acquires.push(JSON.parse(init.body));return Response.json(admissionError??{lease_id:'lease',upstream_model:'gpt-image-2',account:{...stored,id:'1',platform,type:'apikey',credential_version:1}});
  }
  if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
  if(String(url).includes('/rpc/'))return Response.json(null);
  providerCalls++;assert.equal(String(url),'https://api.openai.com/v1/images/generations');
  return upstreamStatus===200?Response.json({created:1,data:[{b64_json:'aW1hZ2U='}],usage:{input_tokens:2,output_tokens:3}}):Response.json({error:{message:'private upstream detail'}},{status:upstreamStatus});
 });return {db,acquires,finishes,get providerCalls(){return providerCalls;}};
}

test('trusted image jobs use the persisted hash, original IP and fenced lease in native admission',async()=>{
 const f=await fixture(),response=await proxyImageJob(request(),job,f.db,context());assert.equal(response.status,200);assert.equal(f.providerCalls,1);
 assert.equal(f.acquires[0].p_key_hash,job.key_hash);assert.equal(f.acquires[0].p_client_ip,job.client_ip);assert.equal(f.acquires[0].p_billing_context.image_task,job.id);assert.equal(f.acquires[0].p_billing_context.image_job_lease,job.lease_id);
 assert.equal(f.finishes.length,1);assert.equal(f.finishes[0].p_outcome,'completed');assert.equal(f.finishes[0].p_output_tokens,3);
});

test('job payload cannot switch models or enable streaming before admission',async()=>{
 for(const body of [{model:'other',prompt:'Tree'},{model:'image-alias',prompt:'Tree',stream:true}]){
  const f=await fixture();await assert.rejects(proxyImageJob(request(body),job,f.db,context()),/image_task_input_mismatch/);assert.equal(f.acquires.length,0);assert.equal(f.providerCalls,0);
 }
});

test('invalid internal identity and fenced admission rejection cannot invoke inference',async()=>{
 for(const override of [{id:'other'},{lease_id:'forged'},{key_hash:'raw-key'},{operation:'chat'},{platform:'gemini'}]){
  const f=await fixture();await assert.rejects(proxyImageJob(request(),{...job,...override},f.db,context()),/invalid_image_job_identity/);assert.equal(f.acquires.length,0);
 }
 const f=await fixture({admissionError:{error:'image_task_lease_lost',status:409}});await assert.rejects(proxyImageJob(request(),job,f.db,context()),error=>error.status===409);assert.equal(f.providerCalls,0);
});

test('jobs never resubmit image inference after a provider HTTP failure',async()=>{
 for(const status of [401,403,429,500,503]){
  const f=await fixture({upstreamStatus:status});await assert.rejects(proxyImageJob(request(),job,f.db,context()),error=>!error.message.includes('private upstream detail'));assert.equal(f.providerCalls,1);assert.equal(f.acquires.length,1);assert.equal(f.finishes.length,1);
 }
});

test('public clients cannot inject job identity through bodies or headers',async()=>{
 const f=await fixture();await proxy(request({model:'image-alias',prompt:'Tree',image_task:job.id,image_job_lease:job.lease_id,key_hash:job.key_hash} ),'/v1/images/generations','sk-client',f.db,context());
 assert.equal(f.acquires[0].p_key_hash,await hashKey('sk-client'));assert.equal(f.acquires[0].p_client_ip,'198.51.100.9');assert.equal(f.acquires[0].p_billing_context.image_task,undefined);assert.equal(f.acquires[0].p_billing_context.image_job_lease,undefined);
});

test('worker platform snapshot is enforced before upstream dispatch',async()=>{
 const f=await fixture({platform:'grok'});await assert.rejects(proxyImageJob(request(),job,f.db,context()),/provider_route_mismatch/);assert.equal(f.providerCalls,0);assert.equal(f.finishes.length,1);
});
