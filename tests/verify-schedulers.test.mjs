import test from 'node:test';
import assert from 'node:assert/strict';
import {verifySchedulers} from '../scripts/verify-schedulers.mjs';
const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_ACCESS_TOKEN:'private-token'};
function fixture({disabled=false,failed=false,codexDisabled=false,empty=false,missingKey=false}={}){
 let calls=0;return async(url,init)=>{
  calls++;assert.equal(url,'https://api.supabase.com/v1/projects/project/database/query');assert.equal(init.redirect,'error');
  assert.equal(new Headers(init.headers).get('authorization'),'Bearer private-token');
  const query=JSON.parse(init.body).query;assert.equal(query.includes('decrypted_secret'),false);
  if(query.includes('FROM cron.job'))return Response.json(['codex','gemini-cache','images','batch-images'].map(kind=>({jobname:'s2a-'+kind+'-jobs',active:!disabled,codex_disabled:codexDisabled})));
  if(query.includes('jobs_dispatch()'))return Response.json(['codex','gemini-cache','images','batch-images'].map((kind,index)=>({kind,request_id:(codexDisabled||missingKey)&&kind==='codex'?null:index+1})));
  if(empty||calls===3)return Response.json([]);
  return Response.json([1,2,3,4].map(id=>({id,status_code:failed?401:id>2?202:200,timed_out:false,has_error:false})));
 };
}
test('Scheduler acceptance waits for actual HTTP responses after cron dispatch',async()=>{
 let pauses=0;const results=await verifySchedulers(env,fixture(),async()=>{pauses++;});
 assert.equal(pauses,1);assert.deepEqual(results,['codex','gemini-cache','images','batch-images']);
});
test('Scheduler acceptance rejects inactive schedules and failed HTTP delivery',async()=>{
 await assert.rejects(verifySchedulers(env,fixture({disabled:true}),async()=>{}),/missing or disabled/);
 await assert.rejects(verifySchedulers(env,fixture({failed:true}),async()=>{}),/delivery failed: codex \(HTTP 401\)/);
 await assert.rejects(verifySchedulers(env,fixture({empty:true}),async()=>{}),/responses are still pending/);
 await assert.rejects(verifySchedulers(env,fixture({missingKey:true}),async()=>{}),/did not enqueue a request: codex/);
});
test('Scheduler acceptance respects disabled Codex auto-sync without leaking configuration',async()=>{
 const result=await verifySchedulers(env,fixture({codexDisabled:true}),async()=>{});
 assert.ok(result.includes('codex-disabled-by-setting'));assert.equal(result.length,4);
 await assert.rejects(verifySchedulers({...env,SUPABASE_URL:'https://user:secret@project.supabase.co'}),/Configure a cloud/);
});
