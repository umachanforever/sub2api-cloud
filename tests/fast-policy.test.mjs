import test from 'node:test';
import assert from 'node:assert/strict';
import {applyFastPolicy} from '../supabase/functions/sub2api/fast_policy.ts';
import {createHandler} from './handler.mjs';
const account={platform:'openai',type:'apikey'};
const context=(rules,force_priority=false)=>({user_id:'7',force_priority,settings:{rules}});
const rule=(action,extra={})=>({service_tier:'all',action,scope:'all',...extra});
test('user-specific rules precede global rules while preserving first-match order',async()=>{
 const body={service_tier:'priority'};
 await applyFastPolicy(body,context([rule('block'),rule('filter',{user_ids:[7]}),rule('block',{user_ids:[7]})]),account,'gpt-6-sol');
 assert.equal(body.service_tier,undefined);
 await assert.rejects(async()=>await applyFastPolicy({service_tier:'priority'},context([rule('block',{error_message:'denied'})]),account,'gpt-6-sol'),error=>error.status===403&&error.message==='denied');
});
test('model matching is exact or trailing prefix and fallback applies only within the first matching rule',async()=>{
 for(const model of ['gpt-6-sol','gpt-6.1-sol']){
  const body={service_tier:'flex'};
  await applyFastPolicy(body,context([rule('force_priority',{model_whitelist:['gpt-6*'],fallback_action:'block'})]),account,model);assert.equal(body.service_tier,'priority');
 }
 await assert.rejects(async()=>await applyFastPolicy({service_tier:'flex'},context([rule('pass',{model_whitelist:['GPT-*'],fallback_action:'block',fallback_error_message:'fallback'})]),account,'gpt-6-sol'),error=>error.message==='fallback');
});
test('group forcing is evaluated before global policy and missing-tier rules are explicit opt-in',async()=>{
 const filtered={};await applyFastPolicy(filtered,context([rule('filter',{service_tier:'priority'})],true),account,'model');assert.deepEqual(filtered,{});
 const missing={};await applyFastPolicy(missing,context([rule('force_priority')]),account,'model');assert.deepEqual(missing,{});
 await applyFastPolicy(missing,context([rule('force_priority',{service_tier:'missing'})]),account,'model');assert.equal(missing.service_tier,'priority');
 const blocked={service_tier:null};await applyFastPolicy(blocked,context([rule('block',{service_tier:'missing'})]),account,'model');assert.equal(blocked.service_tier,null);
});
test('account scopes, user IDs and upstream platform constrain policy application',async()=>{
 for(const type of ['oauth','setup-token']){
  const body={service_tier:'priority'};await applyFastPolicy(body,context([rule('block',{scope:'apikey'}),rule('filter',{scope:'oauth'})]),{platform:'openai',type},'model');assert.deepEqual(body,{});
 }
 const body={service_tier:'priority'};await applyFastPolicy(body,context([rule('block',{user_ids:[8]}),rule('filter',{scope:'bedrock'})]),account,'model');assert.equal(body.service_tier,'priority');
 await applyFastPolicy(body,context([rule('block')],true),{platform:'anthropic',type:'apikey'},'model');assert.equal(body.service_tier,'priority');
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

test('unvalidated message inputs preserve unknown tiers and normalize known aliases on pass',async()=>{
 const unknown={service_tier:'experimental'};await applyFastPolicy(unknown,context([rule('block')]),account,'model');assert.equal(unknown.service_tier,'experimental');
 const numeric={service_tier:7};await applyFastPolicy(numeric,context([rule('force_priority',{service_tier:'missing'})]),account,'model');assert.equal(numeric.service_tier,7);
 const known={service_tier:' FAST '};await applyFastPolicy(known,context([]),account,'model');assert.equal(known.service_tier,'priority');
});

test('original Go parsing rejects typed-corrupt settings as a whole and retains null-rule semantics',async()=>{
 for(const raw of ['not-json','[]','{"rules":[7,{"action":"block"}]}','{"rules":[{"action":"block","user_ids":["7"]}]}','{"rules":[{"action":"block","scope":{}}]}']){
  const body={service_tier:'priority'};
  await applyFastPolicy(body,{user_id:'7',force_priority:false,settings_json:raw},account,'model');
  assert.equal(body.service_tier,'priority');
 }
 const body={service_tier:'priority'};
 await applyFastPolicy(body,{user_id:'7',force_priority:false,settings_json:'{"rules":[null,{"service_tier":"all","action":"block"}]}'},account,'model');
 assert.equal(body.service_tier,'priority');
});
test('original raw settings preserve int64 user identifiers beyond JavaScript precision',async()=>{
 const body={service_tier:'priority'};
 await applyFastPolicy(body,{user_id:'9007199254740993',force_priority:false,settings_json:'{"rules":[{"service_tier":"all","action":"block"},{"service_tier":"all","user_ids":[9007199254740993],"action":"filter"}]}'},account,'model');
 assert.deepEqual(body,{});
});

for(const action of ['filter','force_priority'])for(const type of ['oauth','apikey'])test('Messages '+type+' preserves '+action+' through the Responses bridge and usage finish',async()=>{
 let forwarded;const finishes=[];
 const handler=createHandler({url:'https://db.invalid',serviceKey:'service',encryptionKey:'',adminIds:[],dataModel:'native'},async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',fast_policy:context([rule(action)]),account:{id:'1',platform:'openai',type,credential_storage:'vault',credentials:type==='oauth'?{access_token:'synthetic'}:{api_key:'synthetic'},credential_version:1,codex_settings:{auto_sync:'false'}}});
  if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json(null);}
  forwarded=JSON.parse(init.body);
  return new Response('data: '+JSON.stringify({type:'response.completed',response:{id:'resp',status:'completed',output:[],usage:{input_tokens:1,output_tokens:1}}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
 });
 const response=await handler(new Request('https://gateway/v1/messages',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify({model:'gpt-6',messages:[{role:'user',content:'hello'}],max_tokens:8,service_tier:'flex'})}));
 assert.equal(response.status,200);await response.text();
 assert.equal(forwarded.service_tier,action==='filter'?undefined:'priority');assert.equal(finishes.at(-1).p_service_tier,action==='filter'?null:'priority');
});
