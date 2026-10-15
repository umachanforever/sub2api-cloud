import assert from 'node:assert/strict';
import test from 'node:test';
import {createHmac} from 'node:crypto';
import {Database} from '../supabase/functions/subscription-api/db.ts';
import {encryptCredentials} from '../supabase/functions/subscription-api/credential_store.ts';
import {accountMetadata} from '../supabase/functions/subscription-api/validation.ts';
import {evaluateAutoReset} from '../supabase/functions/subscription-api/openai_auto_reset.ts';
import {resetCreditCandidates,resetAssessment,resetCycle,resetHash,selectResetCredit} from '../supabase/functions/subscription-api/openai_auto_reset_values.ts';
import {createHandler} from './handler.mjs';
const id='11111111-1111-4111-8111-111111111111',operation='22222222-2222-4222-8222-222222222222',lease='33333333-3333-4333-8333-333333333333';
const config={url:'https://db.example',serviceKey:'private-service',encryptionKey:Buffer.alloc(32,1).toString('base64'),adminIds:[]};
const encrypted=await encryptCredentials({access_token:'private-access',refresh_token:'private-refresh',chatgpt_account_id:'private-account',expires_at:2100000000},config.encryptionKey);
const account={id,...encrypted,platform:'openai',type:'oauth',status:'active',schedulable:true,credential_version:1,extra:{privacy_mode:'training_off',auto_reset_credit_enabled:true,auto_reset_credit_5h_threshold:0.8,auto_reset_credit_7d_threshold:1}};
const job={account_id:id,revision:1,lease_id:lease};
const window={used_percent:80,limit_window_seconds:18000,reset_at:2000000000,reset_after_seconds:60};
const usage={rate_limit:{allowed:true,limit_reached:false,primary_window:window},rate_limit_reset_credits:{available_count:2}};
const cards=[{id:'later-private-card',reset_type:'codex_rate_limits',status:'available',expires_at:'2031-01-01T00:00:00Z'},{id:'earlier-private-card',reset_type:'codex_rate_limits',status:'available',expires_at:'2030-01-01T00:00:00Z'}];
function fake(overrides={}){
 const calls=[];let consumes=0,queries=0;const states=[];
 const db=new Database(config,async(url,init)=>{
  const path=new URL(url).pathname,args=init?.body?JSON.parse(init.body):undefined;calls.push({path,args});
  if(overrides[path])return overrides[path](args,init);
  if(path==='/rest/v1/s2a_accounts')return Response.json([account]);
  if(path.endsWith('/s2a_openai_auto_reset_pending'))return Response.json(null);
  if(path.endsWith('/s2a_openai_auto_reset_state') || path.endsWith('/s2a_openai_auto_reset_finish')){states.push(args);return Response.json(true);}
  if(path.endsWith('/usage')){queries++;return Response.json(usage);}
  if(path.endsWith('/rate-limit-reset-credits'))return Response.json({available_count:2,credits:cards});
  if(path.endsWith('/s2a_openai_quota_cache_save')){assert.equal(JSON.stringify(args).includes('private-card'),false);return Response.json(true);}
  if(path.endsWith('/s2a_openai_quota_reset_begin')){assert.equal(args.p_actor_id,null);assert.equal(args.p_credit_id,'earlier-private-card');assert.match(args.p_key,/^auto:[a-f0-9]{24}:[a-f0-9]{24}$/);return Response.json({id:operation,lease_id:lease,consumed:null});}
  if(path.endsWith('/s2a_openai_quota_reset_dispatch') || path.endsWith('/s2a_openai_quota_reset_consumed') || path.endsWith('/s2a_openai_quota_reset_finish'))return Response.json(true);
  if(path.endsWith('/consume')){consumes++;assert.deepEqual(args,{redeem_request_id:operation,credit_id:'earlier-private-card'});assert.equal(init.redirect,'error');return Response.json({code:'success',windows_reset:1,credit:null});}
  assert.ok(path.endsWith('/s2a_account_recover'));return Response.json({id});
 });
 return {db,calls,states,get consumes(){return consumes;},get queries(){return queries;}};
}

test('auto reset configuration defaults, normalizes thresholds and strips worker state',()=>{
 assert.deepEqual(accountMetadata({auto_reset_credit_enabled:true,codex_auto_reset_credit_state:{attempt_credit_hash:'fake'}},'openai','oauth'),{auto_reset_credit_enabled:true,auto_reset_credit_5h_threshold:1,auto_reset_credit_7d_threshold:1});
 assert.equal(accountMetadata({auto_reset_credit_5h_threshold:'0.001'}).auto_reset_credit_5h_threshold,0.001);
 for(const value of [0,1.01,NaN,Infinity,'',null,false])assert.throws(()=>accountMetadata({auto_reset_credit_5h_threshold:value}),{code:'invalid_auto_reset_threshold'});
 assert.throws(()=>accountMetadata({auto_reset_credit_enabled:true},'openai','apikey'),{code:'invalid_auto_reset_account'});
});
test('thresholds use percentages, canonical windows, and stable quota cycle reset times',()=>{
 assert.deepEqual(resetAssessment({...usage,fetched_at:100},account.extra),{reached:true,trigger_window:'5h'});
 assert.equal(resetAssessment({...usage,fetched_at:100,rate_limit:{...usage.rate_limit,primary_window:{...window,used_percent:79.99}}},account.extra).reached,false);
 assert.equal(resetCycle({...usage,fetched_at:100}),`5h:${window.reset_at}|7d:0`);
 assert.equal(resetCycle({fetched_at:100,rate_limit:{allowed:true,limit_reached:true,primary_window:{...window,reset_at:0}}}),'5h:160|7d:0');
});
test('candidate selection picks the earliest expiry and refuses to switch a saved attempt',async()=>{
 const candidates=resetCreditCandidates({credits:cards}),cycle=await resetHash('cycle');
 assert.equal((await selectResetCredit(candidates,2,{},cycle)).id,'earlier-private-card');
 const previous={attempt_cycle_hash:cycle,attempt_credit_hash:await resetHash('later-private-card')};
 assert.equal((await selectResetCredit(candidates,2,previous,cycle)).id,'later-private-card');
 await assert.rejects(selectResetCredit(candidates.slice(1),1,previous,cycle),{code:'OPENAI_AUTO_RESET_ORIGINAL_CREDIT_UNAVAILABLE'});
 await assert.rejects(selectResetCredit(candidates.slice(1),2,{},cycle),{code:'RESET_CREDIT_DETAILS_UNAVAILABLE'});
 await assert.rejects(selectResetCredit([candidates[0],candidates[0]],2,{},cycle),{code:'RESET_CREDIT_DETAILS_UNAVAILABLE'});
 assert.deepEqual(resetCreditCandidates({credits:[{...cards[0],status:'redeemed'}]}),[]);
 for(const entry of [{...cards[0],expires_at:'invalid'},{...cards[0],id:'bad\nheader'},{...cards[0],id:undefined}])assert.throws(()=>resetCreditCandidates({credits:[entry,cards[1]]}),{code:'RESET_CREDIT_DETAILS_UNAVAILABLE'});
 assert.equal(resetCreditCandidates({data:[{creditId:'alternate',expiresAt:'2030-01-01T00:00:00Z'}]})[0].id,'alternate');
});
test('a due account targets one card, journals the receipt and publishes only hashed attempt metadata',async()=>{
 const f=fake();await evaluateAutoReset(job,f.db);assert.equal(f.consumes,1);assert.equal(f.queries,2);
 const finished=f.states.at(-1);assert.equal(finished.p_state.status,'success');assert.equal(finished.p_state.trigger_window,'5h');assert.equal(finished.p_delay,60);
 assert.equal(JSON.stringify(f.states).includes('private'),false);assert.match(finished.p_state.attempt_credit_hash,/^[a-f0-9]{24}$/);
 const consumed=f.calls.findIndex(c=>c.path.endsWith('/s2a_openai_quota_reset_consumed')),recover=f.calls.findIndex(c=>c.path.endsWith('/s2a_account_recover'));assert.ok(consumed<recover);
});
test('below-threshold and no-credit accounts wait ten minutes without consumption',async()=>{
 for(const noCredit of [true,false]){
  const f=fake({'/backend-api/wham/usage':()=>Response.json(noCredit?usage:{...usage,rate_limit:{...usage.rate_limit,primary_window:{...window,used_percent:0}}}),'/backend-api/wham/rate-limit-reset-credits':()=>Response.json({available_count:noCredit?0:2,credits:noCredit?[]:cards})});
  await evaluateAutoReset(job,f.db);assert.equal(f.consumes,0);assert.equal(f.states.at(-1).p_delay,600);assert.equal(f.states.at(-1).p_state.status,noCredit?'no_credit':'available');
 }
});
test('a disabled or stale worker never dispatches a credit',async()=>{
 let loads=0;
 const disabled=fake({'/rest/v1/s2a_accounts':()=>Response.json([{...account,extra:{...account.extra,auto_reset_credit_enabled:++loads===1}}])});
 await evaluateAutoReset(job,disabled.db);assert.equal(disabled.consumes,0);
 const stale=fake({'/rest/v1/rpc/s2a_openai_auto_reset_state':()=>Response.json(false)});
 await evaluateAutoReset(job,stale.db);assert.equal(stale.consumes,0);assert.equal(stale.queries,0);
 const dispatch=fake({'/rest/v1/rpc/s2a_openai_quota_reset_dispatch':()=>Response.json(false)});
 await evaluateAutoReset(job,dispatch.db);assert.equal(dispatch.consumes,0);assert.equal(dispatch.states.at(-1).p_state.status,'resetting');
});
test('incomplete details and provider failures preserve the next retry without leaking provider bodies',async()=>{
 for(const overrides of [{'/backend-api/wham/rate-limit-reset-credits':()=>Response.json({available_count:2,credits:[cards[0]]})},{'/backend-api/wham/usage':()=>new Response('private-provider-error',{status:500})}]){
  const f=fake(overrides);await evaluateAutoReset(job,f.db);assert.equal(f.consumes,0);assert.equal(f.states.at(-1).p_state.status,'failed');assert.equal(f.states.at(-1).p_delay,60);assert.equal(JSON.stringify(f.states).includes('private'),false);
 }
});
test('a pending recorded receipt resumes without selection or a second provider consumption',async()=>{
 const f=fake({'/rest/v1/rpc/s2a_openai_auto_reset_pending':()=>Response.json({key:'auto:saved-key',credit_id:'earlier-private-card'}),'/rest/v1/rpc/s2a_openai_quota_reset_begin':args=>{assert.equal(args.p_key,'auto:saved-key');return Response.json({id:operation,lease_id:lease,consumed:{code:'success',windows_reset:1,credit:null}});}});
 await evaluateAutoReset(job,f.db);assert.equal(f.consumes,0);assert.equal(f.queries,1);assert.equal(f.states.at(-1).p_state.status,'success');
});
test('a targeted no-credit result completes without clearing account limits',async()=>{
 const f=fake({'/backend-api/wham/rate-limit-reset-credits/consume':()=>Response.json({code:'no_credit',windows_reset:0,credit:null})});
 await evaluateAutoReset(job,f.db);assert.equal(f.states.at(-1).p_state.status,'no_credit');assert.equal(f.states.at(-1).p_delay,600);
 assert.equal(f.calls.some(c=>c.path.endsWith('/s2a_account_recover')),false);
});
test('auto reset job tickets require the exact scope and cannot authenticate console requests',async()=>{
 let calls=0;const handler=createHandler(config,async()=>{calls++;return Response.json([]);});
 const now=Math.floor(Date.now()/1000)+60,nonce=crypto.randomUUID(),ticket=scope=>`${now}:${nonce}:${createHmac('sha256',config.serviceKey).update(`s2a-${scope}:${now}:${nonce}`).digest('hex')}`;
 for(const scope of ['privacy','quota-reset']){
  const response=await handler(new Request('https://gateway/internal/jobs/quota-reset',{method:'POST',headers:{'x-s2a-quota-reset-job-token':ticket(scope)}}));assert.equal(response.status,scope==='quota-reset'?200:401);
 }
 assert.equal(calls,1);
 assert.equal((await handler(new Request('https://gateway/api/v1/admin/accounts',{headers:{'x-s2a-quota-reset-job-token':ticket('quota-reset')}}))).status,404);assert.equal(calls,1);
});
