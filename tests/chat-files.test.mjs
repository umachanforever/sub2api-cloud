import test from 'node:test';
import assert from 'node:assert/strict';
import {chatToResponses} from '../supabase/functions/sub2api/openai_protocol.ts';
const convert=content=>chatToResponses({model:'gpt-6.1-sol',messages:[{role:'user',content}]});
test('Chat document data and provider file IDs survive conversion alongside text',()=>{
 const data='data:application/pdf;base64,JVBERi0xLjQ=';
 const content=[{type:'text',text:'Summarize'},{type:'file',file:{filename:'report.pdf',file_data:data}},{type:'file',file:{file_id:'file-123'}}];
 const before=structuredClone(content),result=convert(content);
 assert.deepEqual(result.input[0].content,[{type:'input_text',text:'Summarize'},{type:'input_file',filename:'report.pdf',file_data:data},{type:'input_file',file_id:'file-123'}]);
 assert.deepEqual(content,before);
});
test('empty file parts follow upstream skip semantics without null content',()=>{
 assert.equal(convert([{type:'file',file:{filename:'empty.pdf'}}]).input[0].content,'');
 assert.deepEqual(convert([{type:'file'},{type:'text',text:'hello'}]).input[0].content,[{type:'input_text',text:'hello'}]);
});
test('malformed file fields and files in unsupported roles fail explicitly',()=>{
 for(const file of [null,[],5,{file_data:123},{file_id:{}},{filename:false}])assert.throws(()=>convert([{type:'file',file}]));
 assert.throws(()=>chatToResponses({model:'gpt-6.1-sol',messages:[{role:'assistant',content:[{type:'file',file:{file_id:'x'}}]}]}));
});

test('non-streaming responses recover completed items omitted by the terminal envelope',async()=>{
 const {completedResponse}=await import('../supabase/functions/sub2api/openai_protocol.ts');
 const item={type:'message',role:'assistant',content:[{type:'output_text',text:'PDF-CODE'}]};
 const encode=events=>new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')).body;
 const events=[{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'r',output:[],usage:{output_tokens:3}}}];
 const response=await completedResponse(encode(events));
 assert.deepEqual(response.output,[item]);assert.equal(response.usage.output_tokens,3);
 const final={...item,content:[{type:'output_text',text:'authoritative'}]};
 events[1].response.output=[final];assert.deepEqual((await completedResponse(encode(events))).output,[final]);
 await assert.rejects(completedResponse(encode(events.slice(0,1))),/without completion/);
});
