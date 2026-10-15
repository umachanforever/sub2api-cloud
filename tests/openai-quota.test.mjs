import assert from 'node:assert/strict';
import test from 'node:test';
import {createHandler} from './handler.mjs';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
import {codexCredits,completeResetCredits,quotaUsage,resetCreditDetails} from '../supabase/functions/sub2api/openai_quota_values.ts';
const user='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const config={url:'https://db.example',serviceKey:'service',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[user]};
const encrypted=await encryptCredentials({access_token:'private-access',refresh_token:'private-refresh',chatgpt_account_id:'private-account',expires_at:2100000000},config.encryptionKey);
const account={id,...encrypted,platform:'openai',type:'oauth',credential_version:4};
const credits={has_credits:true,unlimited:false,balance:'12345678901234567890.12345678'};
const window={used_percent:12.5,limit_window_seconds:18000,reset_after_seconds:500,reset_at:2000000000};
const rate={allowed:true,limit_reached:false,primary_window:window,secondary_window:null};
const payload={email:'account@example.com',plan_type:'plus',rate_limit:rate,additional_rate_limits:[{limit_name:'Spark',metered_feature:'codex_bengalfox',rate_limit:rate}],rate_limit_reset_credits:{available_count:2},credits,private_token:'discard'};
const request=(refresh=false,method=refresh?'POST':'GET')=>new Request(`https://gateway/api/v1/admin/openai/accounts/${id}/quota${refresh?'/refresh':''}`,{method,headers:{authorization:'Bearer session','x-s2a-frontend':'1'}});
const app=(fn,actor=user)=>createHandler(config,async(url,init)=>String(url).endsWith('/auth/v1/user')?Response.json({id:actor}):fn(new URL(url),init));

test('quota projection preserves decimal credit balances, unknown values and only typed public fields',()=>{
 const value=quotaUsage(payload,10);assert.deepEqual(value.credits,credits);assert.equal(value.private_token,undefined);assert.equal(value.fetched_at,10);assert.deepEqual(value.rate_limit,rate);
 assert.equal(codexCredits({has_credits:false,unlimited:false}).balance,null);
 assert.deepEqual(quotaUsage({},10),{fetched_at:10});assert.equal(quotaUsage({credits:null},10).credits,null);assert.equal(codexCredits({has_credits:false,unlimited:true,balance:null}).balance,null);
 for(const value of [{has_credits:true,unlimited:false,balance:0},{has_credits:'true',unlimited:false,balance:'0'},{has_credits:true,unlimited:false,balance:'NaN'},{has_credits:true,unlimited:false,balance:'1e20'}])assert.throws(()=>codexCredits(value),{code:'invalid_openai_quota'});
 for(const value of [{rate_limit:{allowed:true}}, {rate_limit:{...rate,primary_window:{...window,used_percent:'12'}}},{additional_rate_limits:{}},{credits:{}}])assert.throws(()=>quotaUsage(value));
});
test('credit details accept upstream envelopes and string counts without leaking credit ids',()=>{
 const items=[{id:'private-id',expiresAt:'2030-01-01T00:00:00Z',resetType:'codex_rate_limits',status:'available'},{credit_id:'private-other',expires_at:'2030-02-01T00:00:00Z'},{expires_at:'2030-01-01',status:'redeemed'},{reset_type:'other',expires_at:'2030-01-01'}];
 for(const envelope of [items,{credits:items},{items},{data:items},{rate_limit_reset_credits:items},{availableCount:'2',credits:items}])assert.deepEqual(resetCreditDetails(envelope),{available_count:2,credits:[{expires_at:'2030-01-01T00:00:00Z'},{expires_at:'2030-02-01T00:00:00Z'}]});
 assert.deepEqual(resetCreditDetails({available_count:'4',credits:'bad'}),{available_count:4});assert.deepEqual(resetCreditDetails({availableCount:'bad'}),{});
 assert.deepEqual(resetCreditDetails([{id:'private',status:'available'}]),{available_count:1,credits:[]});
 assert.equal(completeResetCredits({available_count:2,credits:[{expires_at:'2030-01-01'}]}),false);assert.equal(completeResetCredits({available_count:0}),true);
});
test('quota display caches survive backup metadata validation and discard unknown fields',async()=>{
 const {accountMetadata}=await import('../supabase/functions/sub2api/validation.ts');
 const extra={codex_credits_snapshot:{credits,fetched_at:10},codex_reset_credit_snapshot:{available_count:1,credits:[{expires_at:'2030-01-01T00:00:00Z',id:'private'}]}};
 const normalized=accountMetadata(extra);assert.deepEqual(normalized.codex_credits_snapshot,extra.codex_credits_snapshot);assert.equal(JSON.stringify(normalized).includes('private'),false);
 assert.throws(()=>accountMetadata({codex_credits_snapshot:{credits:{balance:0},fetched_at:10}}),{code:'invalid_codex_quota_snapshot'});
});
