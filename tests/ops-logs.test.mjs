import assert from 'node:assert/strict';
import test from 'node:test';
import {createHandler} from '../supabase/functions/subscription-api/app.ts';
import {Database} from '../supabase/functions/subscription-api/db.ts';
import {recordResponse} from '../supabase/functions/subscription-api/ops_logs.ts';
import {configureJobScheduler} from '../scripts/job-scheduler.mjs';
const actor='11111111-1111-4111-8111-111111111111';
const config={url:'https://db.example',serviceKey:'private-service-key',encryptionKey:'',adminIds:[actor]};
const root='/api/v1/admin/ops';
const request=(path,method='GET',body)=>new Request('https://gateway'+root+path,{method,headers:{authorization:'Bearer private-jwt','x-s2a-frontend':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})});
test('request logging preserves sanitized failures and isolates sink failures',async()=>{
 const events=[];
 const handler=createHandler(config,async(url,init)=>{
  if(String(url).endsWith('/auth/v1/user'))return Response.json({id:actor});
  if(String(url).endsWith('/s2a_admin_context'))return Response.json({admin_ids:[actor]});
  if(String(url).endsWith('/s2a_log_write')){events.push(JSON.parse(init.body).p_event);return Response.json(true);}
  throw Error('private-credential-with-private-query');
 });
 const response=await handler(new Request('https://gateway/v1/models?secret=private-query',{headers:{authorization:'Bearer private-jwt'}}));
 assert.equal(response.status,500);assert.equal(events[0].message,'unhandled_error');assert.equal(events[0].user_id,undefined);assert.equal(events[0].level,'error');
 assert.equal(JSON.stringify(events).includes('private'),false);assert.equal(JSON.stringify(events).includes('runtime/logging'),false);assert.equal(events[0].extra.response_started_ms>=0,true);
 const failedSink=createHandler(config,async()=>{throw Error('private-password');});
 assert.equal((await failedSink(new Request('https://gateway/health'))).status,200);
});
test('response logging never reads or closes a streaming body',async()=>{
 let pulls=0;
 const response=new Response(new ReadableStream({pull(){pulls++;}},{highWaterMark:0}));
 const db=new Database(config,async()=>Response.json(true));
 await recordResponse(db,new Request('https://gateway/v1/responses'),response,Date.now(),actor);
 assert.equal(pulls,0);assert.equal(response.bodyUsed,false);assert.equal(response.body.locked,false);
 await response.body.cancel();
});
test('deployment enables log retention after provider job schedules and fails closed on errors',async()=>{
 const calls=[];
 await configureJobScheduler({SUPABASE_URL:config.url,SUPABASE_SERVICE_ROLE_KEY:config.serviceKey},config.url,async(url,init)=>{
  calls.push(new URL(url).pathname.split('/').at(-1));
  if(calls.length===3)assert.deepEqual(JSON.parse(init.body),{p_enabled:true});
  if(calls.length>=4)assert.deepEqual(JSON.parse(init.body),{});
  return Response.json(calls.length===4?{cleanup_enabled:true,aggregation_enabled:false}:{enabled:true});
 });
 assert.deepEqual(calls,['s2a_privacy_scheduler_configure','s2a_openai_auto_reset_scheduler_configure','s2a_log_scheduler_configure','s2a_ops_scheduler_configure','s2a_ops_alert_scheduler_configure','s2a_ops_email_scheduler_configure']);
 await assert.rejects(configureJobScheduler({SUPABASE_URL:config.url,SUPABASE_SERVICE_ROLE_KEY:config.serviceKey},config.url,async url=>String(url).endsWith('s2a_log_scheduler_configure')?Response.json({enabled:false}):Response.json({enabled:true})),/configuration failed/);
});
