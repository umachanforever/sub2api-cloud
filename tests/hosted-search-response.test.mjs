import test from 'node:test';
import assert from 'node:assert/strict';
import {proxy} from '../supabase/functions/sub2api/proxy.ts';
const search={id:'search-1',type:'web_search_call',status:'completed',action:{type:'search',query:'news'}};
const citation={type:'url_citation',url:'https://example.com/news',title:'Source',start_index:0,end_index:6};
const message={id:'message-1',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Answer',annotations:[citation]}]};
async function fixture({stream=true,tools,failed=false,custom=false}={}){
 const finishes=[];
 const db={config:{dataModel:'native'},async rpc(name,args){
  if(name==='s2a_personal_acquire')return {lease_id:'lease',account:{id:'1',platform:'openai',type:'oauth',credential_version:1,credential_storage:'vault',codex_settings:{auto_sync:'false'},credentials:{access_token:'private',chatgpt_account_id:'account'}}};
  if(name==='s2a_personal_finish'){finishes.push(args);return null;}
  if(name==='s2a_personal_ops_error_record')return null;
  assert.fail(name);
 },async fetchImpl(url,init){
  const body=JSON.parse(init.body);assert.ok(body.tools.some(t=>['web_search','web_search_preview'].includes(t.type)));
  const output=[search,message,...(custom?[{id:'function-1',type:'function_call',call_id:'call-1',name:'web_search',arguments:'{}'}]:[])];
  const response={id:'response-1',status:failed?'failed':'completed',tools:body.tools,output,usage:{input_tokens:20,output_tokens:7}};
  const events=[{type:'response.created',response:{...response,output:[],status:'in_progress'}},{type:'response.output_item.added',output_index:0,item:{...search,status:'in_progress'}},{type:'response.web_search_call.in_progress',item_id:search.id,output_index:0},{type:'response.web_search_call.searching',item_id:search.id,output_index:0},{type:'response.output_item.done',output_index:0,item:search},{type:'response.web_search_call.completed',item_id:search.id,output_index:0},{type:'response.output_item.added',output_index:1,item:message},{type:'response.output_text.delta',output_index:1,content_index:0,delta:'Answer'},{type:'response.output_item.done',output_index:1,item:message},...(custom?[{type:'response.output_item.done',output_index:2,item:output[2]}]:[]),{type:failed?'response.failed':'response.completed',response}];
  const bytes=new TextEncoder().encode(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  return new Response(new ReadableStream({start(c){for(let offset=0;offset<bytes.length;offset+=31)c.enqueue(bytes.slice(offset,offset+31));c.close();}}),{headers:{'content-type':'text/event-stream'}});
 }};
 const path='/v1/responses',request=new Request('https://gateway.test'+path,{method:'POST',body:JSON.stringify({model:'gpt-6.1',input:'Search the news',stream,...(tools?{tools}:{})})});
 const response=await proxy(request,path,'key',db,{requestId:crypto.randomUUID(),started:Date.now()});const raw=await response.text();return {response,raw,finishes};
}
for(const stream of [false,true])test(`undeclared hosted search stays server-owned stream=${stream}`,async()=>{
 const f=await fixture({stream});assert.equal(f.response.status,200);assert.doesNotMatch(f.raw,/web_search/);assert.match(f.raw,/Answer/);assert.match(f.raw,/https:\/\/example.com\/news/);assert.equal(f.finishes[0].p_input_tokens,20);assert.equal(f.finishes[0].p_output_tokens,7);
});
for(const type of ['web_search','web_search_preview'])test(`caller-declared ${type} keeps native tool events`,async()=>{
 const f=await fixture({tools:[{type}]});assert.match(f.raw,/response.web_search_call.completed/);assert.match(f.raw,/web_search_call/);
});
test('custom client function named web_search remains client-owned',async()=>{
 const f=await fixture({tools:[{type:'function',name:'web_search',parameters:{type:'object',properties:{}}}],custom:true});assert.match(f.raw,/function_call/);assert.match(f.raw,/call-1/);
});
test('upstream failure is never rewritten into successful completion',async()=>{
 const f=await fixture({failed:true});assert.match(f.raw,/response.failed/);assert.doesNotMatch(f.raw,/response.completed/);assert.equal(f.finishes[0].p_outcome,'failed');
});

test('implicit search filtering cancels the upstream reader when the client disconnects',async()=>{
 const {implicitSearchResponse}=await import('../supabase/functions/sub2api/search_model.ts');let cancelled=false;
 const upstream=new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'response.output_text.delta',delta:'First'})+'\n\n'));},cancel(){cancelled=true;}}));
 const reader=implicitSearchResponse(upstream,{}).body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/First/);await reader.cancel();assert.equal(cancelled,true);
});
test('implicit search filtering retains event size bounds',async()=>{
 const {implicitSearchResponse}=await import('../supabase/functions/sub2api/search_model.ts');
 const upstream=new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:'x'.repeat(500)})+'\n\n');
 await assert.rejects(implicitSearchResponse(upstream,{},128).text(),/Upstream event too large/);
});
