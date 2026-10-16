import test from 'node:test';
import assert from 'node:assert/strict';
import {applyFastPolicy} from '../supabase/functions/sub2api/fast_policy.ts';
import {createHandler} from './handler.mjs';
const account={platform:'openai',type:'apikey'};
const context=(rules,force_priority=false)=>({user_id:'7',force_priority,settings:{rules}});
const rule=(action,extra={})=>({service_tier:'all',action,scope:'all',...extra});
test('user-specific rules precede global rules while preserving first-match order',()=>{
 const body={service_tier:'priority'};
 applyFastPolicy(body,context([rule('block'),rule('filter',{user_ids:[7]}),rule('block',{user_ids:[7]})]),account,'gpt-6-sol');
 assert.equal(body.service_tier,undefined);
 assert.throws(()=>applyFastPolicy({service_tier:'priority'},context([rule('block',{error_message:'denied'})]),account,'gpt-6-sol'),error=>error.status===403&&error.message==='denied');
});
test('model matching is exact or trailing prefix and fallback applies only within the first matching rule',()=>{
 for(const model of ['gpt-6-sol','gpt-6.1-sol']){
  const body={service_tier:'flex'};
  applyFastPolicy(body,context([rule('force_priority',{model_whitelist:['gpt-6*'],fallback_action:'block'})]),account,model);assert.equal(body.service_tier,'priority');
 }
 assert.throws(()=>applyFastPolicy({service_tier:'flex'},context([rule('pass',{model_whitelist:['GPT-*'],fallback_action:'block',fallback_error_message:'fallback'})]),account,'gpt-6-sol'),error=>error.message==='fallback');
});
test('group forcing is evaluated before global policy and missing-tier rules are explicit opt-in',()=>{
 const filtered={};applyFastPolicy(filtered,context([rule('filter',{service_tier:'priority'})],true),account,'model');assert.deepEqual(filtered,{});
 const missing={};applyFastPolicy(missing,context([rule('force_priority')]),account,'model');assert.deepEqual(missing,{});
 applyFastPolicy(missing,context([rule('force_priority',{service_tier:'missing'})]),account,'model');assert.equal(missing.service_tier,'priority');
 const blocked={service_tier:null};applyFastPolicy(blocked,context([rule('block',{service_tier:'missing'})]),account,'model');assert.equal(blocked.service_tier,null);
});
test('account scopes, user IDs and upstream platform constrain policy application',()=>{
 for(const type of ['oauth','setup-token']){
  const body={service_tier:'priority'};applyFastPolicy(body,context([rule('block',{scope:'apikey'}),rule('filter',{scope:'oauth'})]),{platform:'openai',type},'model');assert.deepEqual(body,{});
 }
 const body={service_tier:'priority'};applyFastPolicy(body,context([rule('block',{user_ids:[8]}),rule('filter',{scope:'bedrock'})]),account,'model');assert.equal(body.service_tier,'priority');
 applyFastPolicy(body,context([rule('block')],true),{platform:'anthropic',type:'apikey'},'model');assert.equal(body.service_tier,'priority');
});
for(const action of ['block','filter','force_priority'])test('HTTP '+action+' honors the trusted acquisition snapshot and releases leases',async()=>{
 const finishes=[];let dispatched=0,forwarded;
 const handler=createHandler({url:'https://db.invalid',serviceKey:'service',encryptionKey:'',adminIds:[],dataModel:'native'},async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',fast_policy:context([rule(action)]),account:{...account,id:'1',credential_storage:'vault',credentials:{api_key:'synthetic'},credential_version:1}});
  if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json(null);}
  if(String(url).includes('ops'))return Response.json(null);
  dispatched++;forwarded=JSON.parse(init.body);return Response.json({id:'resp',object:'response',status:'completed',output:[],usage:{input_tokens:1,output_tokens:1}});
 });
 const response=await handler(new Request('https://gateway/v1/responses',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify({model:'gpt-6',input:'hello',service_tier:'flex',fast_policy:context([])})}));
 assert.equal(response.status,action==='block'?403:200);assert.equal(dispatched,action==='block'?0:1);assert.equal(finishes.length,1);assert.equal(finishes[0].p_status,action==='block'?403:200);
 if(action!=='block')assert.equal(forwarded.service_tier,action==='filter'?undefined:'priority');
});

test('unvalidated message inputs preserve unknown tiers and normalize known aliases on pass',()=>{
 const unknown={service_tier:'experimental'};applyFastPolicy(unknown,context([rule('block')]),account,'model');assert.equal(unknown.service_tier,'experimental');
 const numeric={service_tier:7};applyFastPolicy(numeric,context([rule('force_priority',{service_tier:'missing'})]),account,'model');assert.equal(numeric.service_tier,7);
 const known={service_tier:' FAST '};applyFastPolicy(known,context([]),account,'model');assert.equal(known.service_tier,'priority');
});
