import test from 'node:test';
import assert from 'node:assert/strict';
import {enableNativeSearch} from '../supabase/functions/sub2api/search_model.ts';
import {responseToChat} from '../supabase/functions/sub2api/openai_protocol.ts';
test('hosted search preserves existing tools, instructions and caller tool choice',()=>{
 const body={tools:[{type:'function',name:'test'}],instructions:'original',tool_choice:'auto'};
 enableNativeSearch(body);assert.equal(body.tools[0].name,'test');assert.equal(body.tools[1].type,'web_search');assert.equal(body.tool_choice,'auto');assert.match(body.instructions,/original/);
 enableNativeSearch(body);assert.equal(body.tools.filter(t=>t.type==='web_search').length,1);
});
test('caller search configuration and explicit disable remain respected',()=>{
 const body={tools:[{type:'web_search',search_context_size:'low'}],tool_choice:'none'};
 enableNativeSearch(body);assert.equal(body.tools.length,1);assert.equal(body.tools[0].search_context_size,'low');assert.equal(body.tool_choice,'none');
});
test('chat output retains native source citations',()=>{
 const result=responseToChat({output:[{type:'message',content:[{type:'output_text',text:'Source',annotations:[{type:'url_citation',url:'https://openai.com',title:'OpenAI',start_index:0,end_index:6}]}]}]},'id');
 assert.equal(result.choices[0].message.annotations[0].url_citation.url,'https://openai.com');
});

test('instructions use real paragraph breaks',()=>{
 const body={instructions:'original'};enableNativeSearch(body);
 assert.ok(body.instructions.includes('original\n\nUse web search'));
});
test('stream citations survive annotation events and sparse terminal envelopes',async()=>{
 const {streamChat}=await import('../supabase/functions/sub2api/openai_protocol.ts');
 const annotation={type:'url_citation',url:'https://example.com',title:'Source',start_index:0,end_index:6};
 const events=[{type:'response.created',response:{model:'gpt-6.1-sol'}},{type:'response.output_text.delta',delta:'Source'},
  {type:'response.output_text.annotation.added',output_index:0,content_index:0,annotation_index:0,annotation},
  {type:'response.completed',response:{status:'completed',output:[]}}];
 const source=new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')).body;
 const result=await new Response(streamChat(source,'id','gpt-6.1-sol',false)).text();
 assert.ok(result.includes('url_citation'));assert.ok(result.includes('https://example.com'));assert.ok(result.includes('[DONE]'));
});

test('stream restores completed items and emits each citation once',async()=>{
 const {streamChat}=await import('../supabase/functions/sub2api/openai_protocol.ts');
 const annotation={type:'url_citation',url:'https://example.com',title:'Source',start_index:0,end_index:6};
 for(const incremental of [false,true]){
  const events=[...(incremental?[{type:'response.output_text.annotation.added',annotation}]:[]),
   {type:'response.output_item.done',output_index:0,item:{type:'message',content:[{type:'output_text',text:'Source',annotations:[annotation]}]}},
   {type:'response.completed',response:{status:'completed',output:[]}}];
  const source=new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')).body;
  const text=await new Response(streamChat(source,'id','gpt-6.1-sol',false)).text();
  const chunks=text.split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6)));
  assert.equal(chunks.flatMap(c=>c.choices?.[0]?.delta?.annotations??[]).length,1);
  assert.equal(chunks.map(c=>c.choices?.[0]?.delta?.content??'').join(''),'Source');
 }
});
test('empty client tool catalogs do not disable server-hosted tools',()=>{
 for(const tools of [undefined,[]]){
  const body={tools,tool_choice:'none'};enableNativeSearch(body);assert.equal(body.tool_choice,'auto');assert.equal(body.tools[0].type,'web_search');
 }
 const explicit={tools:[{type:'function',name:'local'}],tool_choice:'none'};enableNativeSearch(explicit);assert.equal(explicit.tool_choice,'none');
});
