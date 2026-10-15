import assert from 'node:assert/strict';import test from 'node:test';
import {createHandler} from './handler.mjs';import {encryptCredentials} from '../supabase/functions/subscription-api/credential_store.ts';
import {quotaResetResult,quotaWindowUpdates} from '../supabase/functions/subscription-api/openai_quota_values.ts';
const user='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',opId='33333333-3333-4333-8333-333333333333',lease='44444444-4444-4444-8444-444444444444';
const config={url:'https://db.example',serviceKey:'service',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[user]};
const encrypted=await encryptCredentials({access_token:'private-access',refresh_token:'private-refresh',chatgpt_account_id:'private-account',expires_at:2100000000},config.encryptionKey);
const row={id,...encrypted,platform:'openai',type:'oauth',credential_version:4};
const publicRow={id,platform:'openai',type:'oauth',status:'active',extra:{privacy_mode:'training_off'}};
const receipt={code:'success',windows_reset:1,credit:{id:'credit-1',status:'redeemed'}};
const usage={credits:{has_credits:true,unlimited:false,balance:'12.12345678'},rate_limit:{allowed:true,limit_reached:false,primary_window:{used_percent:0,limit_window_seconds:18000,reset_after_seconds:60,reset_at:2000000000}}};
const request=(headers={},method='POST')=>new Request(`https://gateway/api/v1/admin/openai/accounts/${id}/reset-quota`,{method,headers:{authorization:'Bearer session','x-s2a-frontend':'1','idempotency-key':'request-key',...headers}});
const app=(fn,actor=user)=>createHandler(config,async(url,init)=>String(url).endsWith('/auth/v1/user')?Response.json({id:actor}):fn(new URL(url),init));
function fetcher(overrides={}){
 const seen=[];let consumes=0;return {seen,get consumes(){return consumes;},run:async(url,init)=>{
  seen.push(url.pathname);if(overrides[url.pathname])return overrides[url.pathname](url,init);
  if(url.pathname==='/rest/v1/s2a_accounts')return Response.json([url.searchParams.get('select').includes('ciphertext')?row:publicRow]);
  if(url.pathname.endsWith('/s2a_openai_quota_reset_begin')){assert.deepEqual(JSON.parse(init.body),{p_account_id:id,p_actor_id:user,p_key:'request-key',p_version:4});return Response.json({id:opId,lease_id:lease,consumed:null});}
  if(url.pathname.endsWith('/s2a_openai_quota_reset_dispatch'))return Response.json(true);
  if(url.pathname.endsWith('/consume')){consumes++;assert.equal(url.hostname,'chatgpt.com');assert.equal(init.method,'POST');assert.equal(init.redirect,'error');assert.deepEqual(JSON.parse(init.body),{redeem_request_id:opId});assert.equal(new Headers(init.headers).get('authorization'),'Bearer private-access');return Response.json({...receipt,private_token:'discard'});}
  if(url.pathname.endsWith('/s2a_openai_quota_reset_consumed')){assert.deepEqual(JSON.parse(init.body).p_result,receipt);return Response.json(true);}
  if(url.pathname.endsWith('/s2a_account_recover')){assert.equal(JSON.parse(init.body).p_action,'recover-state');return Response.json({id});}
  if(url.pathname.endsWith('/usage'))return Response.json(usage);
  if(url.pathname.endsWith('/rate-limit-reset-credits'))return Response.json({available_count:0});
  if(url.pathname.endsWith('/s2a_openai_quota_cache_save')){const args=JSON.parse(init.body);assert.equal(args.p_windows.codex_5h_used_percent,0);return Response.json(true);}
  assert.ok(url.pathname.endsWith('/s2a_openai_quota_reset_finish'));const args=JSON.parse(init.body);assert.equal(args.p_response.account,undefined);return Response.json(true);
 }};
}
test('receipt and window normalization preserve only known values and canonical short/long windows',()=>{
 assert.deepEqual(quotaResetResult({...receipt,access_token:'discard'}),receipt);
 assert.deepEqual(quotaResetResult({code:'success',windows_reset:0}),{code:'success',windows_reset:0,credit:null});
 assert.throws(()=>quotaResetResult({code:'private-body\nsecret',windows_reset:1}));
 const short={used_percent:2,limit_window_seconds:18000,reset_after_seconds:60,reset_at:100},long={...short,used_percent:7,limit_window_seconds:604800};
 const value=quotaWindowUpdates({fetched_at:100,rate_limit:{allowed:true,limit_reached:false,primary_window:long,secondary_window:short}});assert.equal(value.codex_5h_used_percent,2);assert.equal(value.codex_7d_used_percent,7);assert.equal(value.codex_5h_reset_at,new Date(160000).toISOString());
 assert.deepEqual(quotaWindowUpdates({fetched_at:100,rate_limit:null}),{});
});
