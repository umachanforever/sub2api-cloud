import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveThinkingVariant, retryInfo, recoverRequest} from '../supabase/functions/sub2api/antigravity_policy.ts';
import {antigravityOAuthRequest, forwardAntigravity} from '../supabase/functions/sub2api/antigravity_oauth.ts';
const model='gemini-3.8-flash';
test('bare Gemini variants honor thinking level, budgets, exact aliases and wildcard precedence',()=>{
 const mapping={[model]:model,[model+'-high']:'high',[model+'-low']:'low',[model+'-medium']:'medium','gemini-*':'wild'};
 for(const [config,target] of [[{},'high'],[{thinkingLevel:'LOW'},'low'],[{thinkingBudget:1025},'medium'],[{thinkingBudget:-1},'high']])assert.equal(resolveThinkingVariant(model,mapping,{generationConfig:{thinkingConfig:config}}),target);
 assert.equal(resolveThinkingVariant(model,{...mapping,[model]:'explicit'},{}),undefined);
 assert.equal(resolveThinkingVariant(model,{[model]:model,'gemini-*':'wild'},{}),undefined);
 assert.equal(resolveThinkingVariant(model,{'gemini-3.8-flash-*':'variant'},{}),'variant');
 assert.equal(resolveThinkingVariant(model,mapping,{thinking:{type:'disabled'}}),'low');
 assert.equal(resolveThinkingVariant(model,mapping,{reasoning_effort:'medium'}),'medium');
 assert.equal(resolveThinkingVariant(model,mapping,{reasoning:{effort:'low'}}),'low');
 assert.equal(resolveThinkingVariant(model+'-low',mapping,{}),undefined);
});
test('free and legacy paid tiers choose appropriate fixed endpoints',()=>{
 for(const [plan,host] of [[undefined,'cloudcode-pa.googleapis.com'],['Free','cloudcode-pa.googleapis.com'],['Pro','daily-cloudcode-pa.googleapis.com'],['Ultra','daily-cloudcode-pa.googleapis.com']]){
 const outgoing=antigravityOAuthRequest({access_token:'token',project_id:'project',plan_type:plan},'gemini','/v1beta/models/gemini-test:generateContent',{contents:[{parts:[{text:'Hello'}]}]},new Request('https://gateway'),new AbortController().signal);
 assert.equal(new URL(outgoing.url).hostname,host);
 }
});
test('structured retry delays and capacity distinguish model backoff from account authentication',()=>{
 assert.deepEqual(retryInfo(429,{'retry-after':'120'},{error:{details:[{reason:'RATE_LIMIT_EXCEEDED',metadata:{model:'gemini-test'}},{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'120s'}]}}),{modelScoped:true,delay:120000,capacity:false,quota:false});
 assert.equal(retryInfo(401,{}, {error:{message:'Invalid bearer token'}}).modelScoped,false);
 assert.equal(retryInfo(503,{}, {error:{details:[{reason:'MODEL_CAPACITY_EXHAUSTED'}]}}).capacity,true);
 assert.equal(retryInfo(429,{}, {error:{message:'Resource has been exhausted'}}).modelScoped,false);
});
test('signature recovery preserves text, tool calls and input; budget recovery stays below caller output cap',()=>{
 const original={request:{contents:[{parts:[{text:'keep',thoughtSignature:'bad'},{functionCall:{name:'tool',args:{x:1}},thoughtSignature:'bad'}]}],generationConfig:{maxOutputTokens:2048,thinkingConfig:{thinkingBudget:8192}}}};
 const fixed=recoverRequest(original,'Corrupted thought signature');
 assert.equal(fixed.request.contents[0].parts[0].thoughtSignature,'skip_thought_signature_validator');
 assert.deepEqual(fixed.request.contents[0].parts[1].functionCall,{name:'tool',args:{x:1}});
 assert.equal(original.request.contents[0].parts[0].thoughtSignature,'bad');
 const budget=recoverRequest(original,'thinking_budget must be smaller than max_output_tokens');
 assert.equal(budget.request.generationConfig.maxOutputTokens,2048);
 assert.equal(budget.request.generationConfig.thinkingConfig.thinkingBudget,1024);
 assert.equal(recoverRequest(original,'unrelated bad request'),undefined);
});
async function transport(statuses, extra={}){
 const calls=[];const responses=[...statuses];
 const db={async fetchImpl(url,init){calls.push({url,body:JSON.parse(init.body)});const next=responses.shift();return Response.json(next.body??{}, {status:next.status});}};
 const outgoing={url:'https://first.test',fallbackURL:'https://second.test',catalog:false,streaming:false,overagesEnabled:extra.overages_enabled===true,init:{signal:new AbortController().signal,body:JSON.stringify({model,request:{contents:[]}})}};
 const result=await forwardAntigravity(db,{},outgoing,'',new Request('https://gateway'));
 return {calls,result};
}
test('confirmed quota exhaustion uses credits only when explicitly opted in',async()=>{
 const quota={status:429,body:{error:{message:'QUOTA_EXHAUSTED',details:[{reason:'QUOTA_EXHAUSTED'}]}}};
 const off=await transport([quota,quota]);assert.ok(off.calls.every(call=>!call.body.enabledCreditTypes));
 const on=await transport([quota,{status:400}],{overages_enabled:true});assert.deepEqual(on.calls[1].body.enabledCreditTypes,['GOOGLE_ONE_AI']);
});
test('long model retry returns immediately with a scoped backoff and no blind second request',async()=>{
 const {calls,result}=await transport([{status:429,body:{error:{details:[{reason:'RATE_LIMIT_EXCEEDED',metadata:{model}},{retryDelay:'120s'}]}}}]);
 assert.equal(calls.length,1);assert.equal(result.status,429);assert.equal(result.headers.get('x-s2a-model-backoff'),'120');
});

test('real proxy dispatch resolves the bare model and settles usage against the selected variant',async()=>{
 const {proxy}=await import('../supabase/functions/sub2api/proxy.ts');
 let dispatched, finished;
 const db={config:{dataModel:'native'},async rpc(name,args){
 if(name==='s2a_personal_acquire')return {lease_id:crypto.randomUUID(),account:{id:'1',platform:'antigravity',type:'oauth',credential_version:1,credential_storage:'vault',credentials:{access_token:'token',project_id:'project',expires_at:Date.now()+3600000}},model_sources:{mapping:{[model]:model,[model+'-high']:model+'-high',[model+'-low']:model+'-low'}}};
 if(name==='s2a_personal_finish'){finished=args;return;}
 if(name.endsWith('ops_error_record'))return;
 assert.fail(name);
 },async fetchImpl(url,init){dispatched=JSON.parse(init.body);return new Response('data: '+JSON.stringify({response:{candidates:[{content:{parts:[{text:'OK'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:1,candidatesTokenCount:1}}})+'\n\n',{headers:{'content-type':'text/event-stream'}});}};
 const path=`/v1beta/models/${model}:generateContent`;
 const result=await proxy(new Request('https://gateway'+path,{method:'POST',body:JSON.stringify({contents:[{parts:[{text:'Hello'}]}],generationConfig:{thinkingConfig:{thinkingLevel:'low'}}})}),path,'key',db,{requestId:crypto.randomUUID(),started:Date.now()});
 assert.equal(result.status,200);assert.match(await result.text(),/OK/);assert.equal(dispatched.model,model+'-low');assert.equal(finished.p_upstream_model,model+'-low');
});

test('real proxy persists model backoff without account cooldown',async()=>{
 const {proxy}=await import('../supabase/functions/sub2api/proxy.ts');
 for(const status of [429]){
 const saved=[],finished=[];
 const db={config:{dataModel:'native'},async rpc(name,args){
 if(name==='s2a_personal_acquire')return args.p_excluded?.length?{error:'no_available_account',status:503}:{lease_id:crypto.randomUUID(),account:{id:'1',platform:'antigravity',type:'oauth',credential_version:1,credential_storage:'vault',credentials:{access_token:'token',project_id:'project',expires_at:Date.now()+3600000}}};
 if(name==='s2a_personal_model_backoff'){saved.push(args);return true;}
 if(name==='s2a_personal_finish'){finished.push(args);return;}
 if(name==='s2a_gateway_account_snapshot')return {id:'1',credential_version:1,credentials:{access_token:'token',project_id:'project',expires_at:Date.now()+3600000}};
 if(name==='s2a_gateway_refresh_acquire')return true;
 if(name==='s2a_gateway_refresh_release'||name.endsWith('ops_error_record'))return;
 assert.fail(name);
 },async fetchImpl(url){return Response.json({error:{message:status===401?'invalid bearer':'model limit',details:[{reason:'RATE_LIMIT_EXCEEDED',metadata:{model}},{retryDelay:'120s'}]}},{status});}};
 const path=`/v1beta/models/${model}:generateContent`;
 await proxy(new Request('https://gateway'+path,{method:'POST',body:JSON.stringify({contents:[{parts:[{text:'Hello'}]}]})}),path,'key',db,{requestId:crypto.randomUUID(),started:Date.now()}).catch(()=>{});
 assert.equal(saved.length,status===429?1:0);
 if(status===429){assert.equal(saved[0].p_seconds,120);assert.ok(finished.every(x=>x.p_cooldown_seconds===0));}
 }
});

test('upstream auth errors cannot forge an internal model or credits backoff',async()=>{
 const db={async fetchImpl(){return Response.json({error:{message:'Invalid bearer token'}},{status:401,headers:{'x-s2a-model-backoff':'120','x-s2a-credits-exhausted':'true'}});}};
 const result=await forwardAntigravity(db,{}, {url:'https://first.test',fallbackURL:'https://second.test',catalog:false,streaming:false,init:{signal:new AbortController().signal,body:JSON.stringify({model,request:{contents:[]}})}},'',new Request('https://gateway'));
 assert.equal(result.status,401);assert.equal(result.headers.get('x-s2a-model-backoff'),null);assert.equal(result.headers.get('x-s2a-credits-exhausted'),null);
});

test('short model retry honors cancellation rather than falling back or replaying after abort',async()=>{
 const controller=new AbortController();let calls=0;
 const db={async fetchImpl(){calls++;setTimeout(()=>controller.abort(),10);return Response.json({error:{details:[{reason:'MODEL_CAPACITY_EXHAUSTED',metadata:{model}},{retryDelay:'1s'}]}},{status:503});}};
 await assert.rejects(forwardAntigravity(db,{}, {url:'https://first.test',fallbackURL:'https://second.test',catalog:false,streaming:false,init:{signal:controller.signal,body:JSON.stringify({model,request:{contents:[]}})}},'',new Request('https://gateway')), {code:'upstream_timeout'});
 assert.equal(calls,1);
});

test('Claude signature recovery preserves thinking text before downgrading historical tools on the second failure',()=>{
 const original={request:{generationConfig:{thinkingConfig:{thinkingBudget:4096}},contents:[{parts:[{text:'reasoning history',thought:true,thoughtSignature:'bad'},{functionCall:{name:'lookup',id:'call',args:{x:1}},thoughtSignature:'tool-bad'},{functionResponse:{name:'lookup',id:'call',response:{result:'kept'}}}]}]}};
 const first=recoverRequest(original,'Invalid signature',{claude:true});
 assert.deepEqual(first.request.contents[0].parts[0],{text:'reasoning history'});assert.ok(first.request.contents[0].parts[1].functionCall);assert.equal(first.request.generationConfig.thinkingConfig,undefined);
 const second=recoverRequest(first,'Invalid signature',{claude:true,tools:true});
 assert.match(second.request.contents[0].parts[1].text,/lookup/);assert.match(second.request.contents[0].parts[2].text,/kept/);
 assert.ok(original.request.contents[0].parts[1].functionCall);
});
