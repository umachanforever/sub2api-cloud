import assert from 'node:assert/strict';
import test from 'node:test';
import {proxy} from '../supabase/functions/sub2api/proxy.ts';

for(const stream of [false,true])test(`Codex OAuth Messages accepts server search tools and preserves PDF and structured output (stream=${stream})`,async()=>{
 const finished=[];let forwarded=0;
 const db={config:{dataModel:'native',encryptionKey:''},async rpc(name,body){
  if(name==='s2a_personal_acquire')return {lease_id:'lease',account:{id:'account',platform:'openai',type:'oauth',credential_storage:'vault',credential_version:1,credentials:{access_token:'private-token',expires_at:Date.now()+3600000}}};
  if(name==='s2a_personal_finish'){finished.push(body);return null;}
  if(name==='s2a_personal_ops_error_record')return null;
  assert.fail('Unexpected RPC '+name);
 },async fetchImpl(url,init){
  forwarded++;assert.equal(url,'https://chatgpt.com/backend-api/codex/responses');
  const body=JSON.parse(init.body);assert.equal(body.stream,true);assert.equal(body.store,false);
  assert.equal(body.tools[0].type,'web_search');assert.equal(body.parallel_tool_calls,false);
  assert.equal(body.text.format.type,'json_schema');assert.deepEqual(body.text.format.schema,{type:'object'});
  const file=body.input.flatMap(item=>Array.isArray(item.content)?item.content:[]).find(part=>part.type==='input_file');
  assert.equal(file.filename,'report.pdf');assert.equal(file.file_data,'data:application/pdf;base64,AA==');
  const response={id:'resp',object:'response',model:'gpt-test',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'answer'}]}],usage:{input_tokens:8,output_tokens:2}};
  return new Response('data: '+JSON.stringify({type:'response.completed',response})+'\n\n',{headers:{'content-type':'text/event-stream'}});
 }};
 const body={model:'gpt-test',stream,max_tokens:32,tools:[{type:'web_search_20250305',name:'web_search'}],tool_choice:{type:'auto',disable_parallel_tool_use:true},output_config:{format:{type:'json_schema',schema:{type:'object'}}},messages:[{role:'user',content:[{type:'document',title:'report.pdf',source:{type:'base64',media_type:'application/pdf',data:'AA=='}}]}]};
 const response=await proxy(new Request('https://gateway/v1/messages',{method:'POST',body:JSON.stringify(body)}),'/v1/messages','key',db,{requestId:crypto.randomUUID(),started:Date.now()});
 assert.equal(response.status,200);const text=await response.text();assert.match(text,/answer/);assert.doesNotMatch(text,/private-token/);if(!stream)JSON.parse(text);
 assert.equal(forwarded,1);assert.equal(finished.length,1);assert.equal(finished[0].p_input_tokens,8);assert.equal(finished[0].p_output_tokens,2);
});
