import assert from 'node:assert/strict';import test from 'node:test';
import {quotaHeaderWindows,quotaPauseSettings} from '../supabase/functions/subscription-api/openai_quota_pause.ts';
import {accountMetadata} from '../supabase/functions/subscription-api/validation.ts';
import {encryptCredentials} from '../supabase/functions/subscription-api/credential_store.ts';
import {Database} from '../supabase/functions/subscription-api/db.ts';
import {createHandler} from './handler.mjs';
const id='11111111-1111-4111-8111-111111111111';
const config={url:'https://db.example',serviceKey:'private-service',encryptionKey:Buffer.alloc(32,1).toString('base64'),adminIds:[]};
const encrypted=await encryptCredentials({access_token:'private-access',refresh_token:'private-refresh',chatgpt_account_id:'private-account',expires_at:2100000000},config.encryptionKey);
test('pause settings validate ratios, account platforms and per-window disabled flags',()=>{
 assert.deepEqual(quotaPauseSettings({default_threshold_5h:0.8}),{default_threshold_5h:0.8,default_threshold_7d:0});
 assert.deepEqual(accountMetadata({auto_pause_5h_threshold:'0.95',auto_pause_7d_disabled:true},'openai','oauth'),{auto_pause_5h_threshold:0.95,auto_pause_7d_disabled:true});
 for(const value of [-1,1.01,NaN,null,false,''])assert.throws(()=>accountMetadata({auto_pause_5h_threshold:value}));
 assert.throws(()=>quotaPauseSettings({default_threshold_5h:0.8,private_secret:'discard'}),{code:'invalid_quota_pause_settings'});
 assert.throws(()=>accountMetadata({auto_pause_5h_disabled:true},'anthropic','apikey'),{code:'invalid_quota_pause_account'});
});
test('Codex headers map reversed windows and preserve partial known fields without invented zeros',()=>{
 const result=quotaHeaderWindows(new Headers({'x-codex-primary-used-percent':'95.5','x-codex-primary-window-minutes':'10080','x-codex-primary-reset-after-seconds':'60','x-codex-secondary-used-percent':'20','x-codex-secondary-window-minutes':'300'}),100);
 assert.equal(result.codex_7d_used_percent,95.5);assert.equal(result.codex_5h_used_percent,20);assert.equal(result.codex_7d_reset_at,new Date(160000).toISOString());assert.equal(result.codex_5h_reset_at,undefined);
 assert.equal(quotaHeaderWindows(new Headers({'x-codex-primary-used-percent':'invalid'})),null);
 assert.equal(quotaHeaderWindows(new Headers({'x-codex-primary-reset-after-seconds':'10'}),100).codex_7d_reset_at,new Date(110000).toISOString());
 assert.deepEqual(quotaHeaderWindows(new Headers({'x-codex-primary-used-percent':'0'}),100),{codex_7d_used_percent:0,codex_usage_updated_at:new Date(100000).toISOString()});
 const invalid=quotaHeaderWindows(new Headers({'x-codex-primary-used-percent':'99','x-codex-primary-window-minutes':'NaN','x-codex-primary-reset-after-seconds':'1.5'}),100);assert.equal(invalid.codex_7d_used_percent,99);assert.equal(invalid.codex_7d_reset_at,undefined);
});
test('OAuth response windows persist before settlement, including provider failures',async()=>{
 for(const status of [200,429]){
  const calls=[];let reservations=0;
  const handler=createHandler(config,async(url,init)=>{
   const path=new URL(url).pathname;
   if(path.endsWith('/s2a_acquire')){if(++reservations>1)return Response.json({error:'no_available_account',status:503});return Response.json({lease_id:id,account:{id,...encrypted,platform:'openai',type:'oauth',credential_version:3}});}
   if(path.endsWith('/s2a_openai_windows_save')){const args=JSON.parse(init.body);assert.equal(args.p_version,3);assert.equal(args.p_windows.codex_5h_used_percent,99);calls.push('snapshot');return Response.json(true);}
   if(path.endsWith('/s2a_finish')){calls.push('finish');return Response.json(null);}
   assert.equal(new URL(url).hostname,'chatgpt.com');
   return new Response(status===200?'data: {"type":"response.completed","response":{"id":"response","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n':'private-provider-error',{status,headers:{'content-type':status===200?'text/event-stream':'text/plain','x-codex-primary-used-percent':'99','x-codex-primary-window-minutes':'300','x-codex-primary-reset-after-seconds':'60'}});
  });
  const response=await handler(new Request('https://gateway/v1/responses',{method:'POST',headers:{authorization:'Bearer client-key','content-type':'application/json'},body:JSON.stringify({model:'gpt-4.1',input:'hello',stream:false})}));
  assert.equal(response.status,status===200?200:503);assert.deepEqual(calls,['snapshot','finish']);assert.equal((await response.text()).includes('private'),false);
 }
});
