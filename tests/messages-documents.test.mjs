import test from 'node:test';
import assert from 'node:assert/strict';
import {messagesToResponses,messagesToAPIResponses} from '../supabase/functions/sub2api/anthropic_protocol.ts';
const pdf={type:'document',source:{type:'base64',media_type:'application/pdf',data:'JVBERi0xLjQ='}};
const convert=(blocks,bridge=messagesToResponses)=>bridge({model:'gpt-6.1-sol',max_tokens:128,messages:[{role:'user',content:blocks}]});
test('PDFs retain their data, title, context, and order for both OpenAI bridges',()=>{
 const block={...pdf,title:'report.pdf',context:'Quarterly results',citations:{enabled:false}};
 const before=structuredClone(block);
 for(const bridge of [messagesToResponses,messagesToAPIResponses])assert.deepEqual(convert([{type:'text',text:'Read'},block],bridge).input[0].content,[{type:'input_text',text:'Read'},{type:'input_text',text:'report.pdf'},{type:'input_text',text:'Quarterly results'},{type:'input_file',filename:'report.pdf',file_data:'data:application/pdf;base64,JVBERi0xLjQ='}]);
 assert.deepEqual(block,before);
});
test('URL and plain text documents preserve source content',()=>{
 assert.deepEqual(convert([{type:'document',source:{type:'url',url:'https://example.com/report.pdf'}}]).input[0].content,[{type:'input_file',file_url:'https://example.com/report.pdf'}]);
 assert.deepEqual(convert([{type:'document',source:{type:'text',media_type:'text/plain',data:'中文 document'}}]).input[0].content,[{type:'input_text',text:'中文 document'}]);
});
test('document tool results retain files after function output',()=>{
 const result=convert([{type:'tool_result',tool_use_id:'call_1',content:[{type:'text',text:'Downloaded'},pdf]}]);
 assert.equal(result.input[0].type,'function_call_output');assert.equal(result.input[0].output,'Downloaded');
 assert.equal(result.input[1].content[0].type,'input_file');
});
test('unsupported sources, citations and malformed document metadata fail explicitly',()=>{
 for(const source of [{},{type:'base64',media_type:'application/pdf',data:'%%%%'},{type:'base64',media_type:'application/pdf',data:'A'},{type:'base64',media_type:'image/png',data:'AAAA'},{type:'url',url:'file:///tmp/a.pdf'},{type:'content',content:[]}])assert.throws(()=>convert([{type:'document',source}]));
 for(const patch of [{title:1},{context:{}},{citations:{enabled:true}},{citations:null}])assert.throws(()=>convert([{...pdf,...patch}]));
 assert.throws(()=>messagesToResponses({model:'gpt-6.1-sol',max_tokens:128,messages:[{role:'assistant',content:[pdf]}]}));
});
