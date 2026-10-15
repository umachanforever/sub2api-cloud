import assert from 'node:assert/strict';
import test from 'node:test';
import {createHmac} from 'node:crypto';
import {createBackendHandler as createHandler} from './handler.mjs';
import {runPrivacyJobs} from '../supabase/functions/subscription-api/privacy_jobs.ts';
import {Database} from '../supabase/functions/subscription-api/db.ts';
import {configureJobScheduler} from '../scripts/job-scheduler.mjs';
const config={url:'https://db.example',serviceKey:'secret-service',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[]};
const jobs=Array.from({length:4},(_,i)=>({account_id:`00000000-0000-4000-8000-00000000000${i}`,revision:2,lease_id:`00000000-0000-4000-8000-00000000001${i}`}));
test('privacy endpoint authenticates the exact service key before any database call',async()=>{
 let calls=0;
 const handler=createHandler(config,async(url)=>{calls++;assert.ok(String(url).endsWith('/s2a_privacy_jobs_claim'));return Response.json([]);});
 for(const authorization of [null,'Bearer session','Bearer secret-service-extra','Basic secret-service']){
  const response=await handler(new Request('https://gateway/internal/jobs/privacy',{method:'POST',headers:authorization?{authorization}:{}}));assert.equal(response.status,401);
 }
 assert.equal(calls,0);
 const wrongMethod=await handler(new Request('https://gateway/internal/jobs/privacy',{headers:{authorization:'Bearer secret-service'}}));assert.equal(wrongMethod.status,405);assert.equal(calls,0);
 const response=await handler(new Request('https://gateway/functions/v1/subscription-api/internal/jobs/privacy',{method:'POST',headers:{authorization:'Bearer secret-service'}}));assert.equal(response.status,200);assert.deepEqual(await response.json(),{claimed:0,finished:0});assert.equal(calls,1);
});
test('a bounded queue batch finishes independent jobs and leaves failed completion leases to expire',async()=>{
 let active=0,peak=0;const finishes=[];
 const db=new Database(config,async(url,init)=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/s2a_privacy_jobs_claim'))return Response.json(jobs);
  if(path.endsWith('/s2a_accounts')){
   active++;peak=Math.max(active,peak);await new Promise(r=>setTimeout(r,10));active--;
   const id=new URL(url).searchParams.get('id').slice(3);
   return Response.json(id===jobs[1].account_id?[]:[{id,platform:'openai',type:'oauth',extra:{privacy_mode:'training_off'}}]);
  }
  assert.ok(path.endsWith('/s2a_privacy_jobs_finish'));const args=JSON.parse(init.body);finishes.push(args);
  if(args.p_account_id===jobs[2].account_id)return new Response('secret-error',{status:500});
  return Response.json(args.p_account_id!==jobs[3].account_id);
 });
 assert.deepEqual(await runPrivacyJobs(db),{claimed:4,finished:2});assert.equal(peak,4);
 assert.equal(finishes.find(j=>j.p_account_id===jobs[1].account_id).p_error,'worker_failed');
 assert.ok(finishes.filter(j=>j.p_account_id!==jobs[1].account_id).every(j=>j.p_error===null));
 assert.ok(finishes.every(j=>j.p_revision===2 && j.p_lease_id===jobs.find(row=>row.account_id===j.p_account_id).lease_id));
});
test('scheduler uses structured private RPC and redacts all error responses',async()=>{
 const env={SUPABASE_URL:'http://127.0.0.1:54321',SUPABASE_SERVICE_ROLE_KEY:'private-key'};
 await configureJobScheduler(env,'http://kong:8000',async(url,init)=>{
  assert.equal(init.headers.authorization,'Bearer private-key');
  if(url.endsWith('/s2a_privacy_scheduler_configure'))assert.deepEqual(JSON.parse(init.body),{p_url:'http://kong:8000',p_service_key:'private-key',p_enabled:true});
  else if(url.endsWith('/s2a_ops_scheduler_configure')){assert.deepEqual(JSON.parse(init.body),{});return Response.json({cleanup_enabled:true,aggregation_enabled:false});}
  else if(['/s2a_ops_alert_scheduler_configure','/s2a_ops_email_scheduler_configure'].some(path=>url.endsWith(path))){assert.deepEqual(JSON.parse(init.body),{});return Response.json({enabled:true});}
  else {assert.ok(['s2a_openai_auto_reset_scheduler_configure','s2a_log_scheduler_configure'].some(name=>url===env.SUPABASE_URL+'/rest/v1/rpc/'+name));assert.deepEqual(JSON.parse(init.body),{p_enabled:true});}
  return Response.json({enabled:true});
 });
 for(const result of [()=>new Response('private-key',{status:400}),()=>Response.json({error:'private-key'}),()=>{throw Error('private-key');}])
  await assert.rejects(configureJobScheduler(env,undefined,result),error=>!error.message.includes('private-key') && error.message.includes('configuration failed'));
});

test('scheduler signatures are bound to the privacy scope and expire within ninety seconds',async()=>{
 let calls=0;
 const handler=createHandler(config,async()=>{calls++;return Response.json([]);});
 const nonce=crypto.randomUUID(),now=Math.floor(Date.now()/1000);
 const signed=(expiry,scope='s2a-privacy',key=config.serviceKey)=>`${expiry}:${nonce}:${createHmac('sha256',key).update(`${scope}:${expiry}:${nonce}`).digest('hex')}`;
 for(const token of [signed(now-1),signed(now+100),signed(now+60,'admin'),signed(now+60,undefined,'wrong'),signed(now+60)+'x']){
  assert.equal((await handler(new Request('https://gateway/internal/jobs/privacy',{method:'POST',headers:{'x-s2a-privacy-job-token':token}}))).status,401);
 }
 assert.equal(calls,0);
 const response=await handler(new Request('https://gateway/internal/jobs/privacy',{method:'POST',headers:{'x-s2a-privacy-job-token':signed(now+60)}}));assert.equal(response.status,200);assert.equal(calls,1);
 // A job ticket never authenticates normal administration or provider routes.
 assert.equal((await handler(new Request('https://gateway/api/v1/admin/accounts',{headers:{'x-s2a-privacy-job-token':signed(now+60)}}))).status,404);assert.equal(calls,1);
});

test('canonical gateway does not reactivate retired-table scheduled jobs',async()=>{
 await configureJobScheduler({SUB2API_DATA_MODEL:'native'},undefined,()=>{throw Error('Retired scheduler called');});
});
