import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeServiceTier} from '../supabase/functions/sub2api/service_tier.ts';
import {createHandler} from './handler.mjs';
test('service tiers match original enum validation and canonical spelling',()=>{
 for(const tier of ['auto','default','fast','flex','priority','scale','ultrafast']){
  const body={service_tier:' '+tier.toUpperCase()+' '};normalizeServiceTier(body);
  assert.equal(body.service_tier,tier==='fast'?'priority':tier);
 }
 for(const body of [{},{service_tier:null}]){const before=structuredClone(body);normalizeServiceTier(body);assert.deepEqual(body,before);}
 for(const value of ['', 'unknown', 1, false, [], {}])assert.throws(()=>normalizeServiceTier({service_tier:value}),error=>error.status===400);
});
for(const path of ['/v1/responses','/v1/chat/completions'])test(path+' rejects invalid tiers before account acquisition',async()=>{
 let calls=0;
 const handler=createHandler({url:'https://db.invalid',serviceKey:'service',encryptionKey:'',adminIds:[],dataModel:'native'},async(url)=>{if(String(url).includes('ops'))return Response.json(null);calls++;throw Error('unexpected I/O');});
 for(const value of ['', 'unknown', 1, false, [], {}]){
  const body={model:'gpt-6',service_tier:value,...(path.endsWith('/responses')?{input:'hello'}:{messages:[{role:'user',content:'hello'}]})};
  const response=await handler(new Request('https://gateway'+path,{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify(body)}));
  assert.equal(response.status,400);
 }
 assert.equal(calls,0);
});
for(const path of ['/v1/responses','/v1/chat/completions'])test(path+' normalizes fast before API-key upstream dispatch',async()=>{
 let forwarded;const finishes=[];
 const handler=createHandler({url:'https://db.invalid',serviceKey:'service',encryptionKey:'',adminIds:[],dataModel:'native'},async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',account:{id:'1',platform:'openai',type:'apikey',credential_storage:'vault',credentials:{api_key:'synthetic'},credential_version:1}});
  if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json(null);}
  forwarded=JSON.parse(init.body);
  return Response.json(path.endsWith('/responses')?{id:'resp',object:'response',status:'completed',output:[],usage:{input_tokens:1,output_tokens:1}}:{id:'chat',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}});
 });
 const body={model:'gpt-6',service_tier:' FAST ',...(path.endsWith('/responses')?{input:'hello'}:{messages:[{role:'user',content:'hello'}]})};
 const response=await handler(new Request('https://gateway'+path,{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify(body)}));
 assert.equal(response.status,200);assert.equal(forwarded.service_tier,'priority');assert.equal(finishes.at(-1).p_service_tier,'priority');
});
