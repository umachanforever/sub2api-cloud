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
