import assert from 'node:assert/strict';
import test from 'node:test';
import {originalChatBridgeCount,originalGeminiBridge,originalGeminiRestBody} from '../supabase/functions/sub2api/original_chat_bridge.ts';

test('original AI Studio normalization rewrites search tools without changing Vertex/Code Assist bodies',async()=>{
 const body={contents:[{parts:[{text:'hello'}]}],tools:[{googleSearch:{}},{functionDeclarations:[{name:'lookup'}]}]};
 const result=await originalGeminiRestBody(body);
 assert.deepEqual(result.tools[0],{google_search:{}});assert.deepEqual(result.tools[1],body.tools[1]);
 assert.deepEqual(body.tools[0],{googleSearch:{}});assert.deepEqual(result.contents,body.contents);
});

test('Gemini streaming bridge handles cumulative text, split custom tool arguments, usage and truncation',async()=>{
 for(const truncated of [false,true]){
  const bridge=await originalGeminiBridge({model:'gemini-test',input:'hello',tools:[{type:'custom',name:'exec'}]},'scope');
  assert.equal(bridge.body.contents[0].parts[0].text,'hello');
  const chunks=[
   {candidates:[{content:{parts:[{text:'hel'}]}}]},
   {candidates:[{content:{parts:[{text:'hello'}]}}]},
   {candidates:[{content:{parts:[{text:'hello'}]}}]},
   {candidates:[{content:{parts:[{functionCall:{name:'exec',args:'{"input":"echo'}}]}}]},
   ...(!truncated?[{candidates:[{finishReason:'STOP',content:{parts:[{functionCall:{name:'exec',args:'{"input":"echo hello"}'}}]}}]}]:[]),
   {usageMetadata:{promptTokenCount:8,cachedContentTokenCount:3,candidatesTokenCount:2,thoughtsTokenCount:1}},
  ];
  const source=chunks.map(value=>'data: '+JSON.stringify(value)+'\n\n').join('');
  const result=await bridge.response(new Response(source,{headers:{'content-type':'text/event-stream'}})).text();
  const events=result.split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5)));
  const terminal=events.at(-1);assert.equal(terminal.type,truncated?'response.failed':'response.completed');
  assert.equal(terminal.response.usage.input_tokens,8);assert.equal(terminal.response.usage.output_tokens,3);assert.equal(terminal.response.usage.input_tokens_details.cached_tokens,3);
  if(!truncated){assert.equal(terminal.response.output.find(item=>item.type==='message').content[0].text,'hello');assert.equal(terminal.response.output.find(item=>item.type==='custom_tool_call').input,'echo hello');}
  assert.equal(await originalChatBridgeCount(),0);
 }
});

test('Gemini bridge accepts JSON fallback and preserves output token limits',async()=>{
 const bridge=await originalGeminiBridge({model:'gemini-test',input:'hello'},'scope');
 const result=await bridge.response(Response.json({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'partial'}]}}],usageMetadata:{promptTokenCount:4,candidatesTokenCount:2}})).text();
 const terminal=JSON.parse(result.split('\n').find(line=>line.startsWith('data:')).slice(5));
 assert.equal(terminal.response.status,'incomplete');assert.equal(terminal.response.output[0].content[0].text,'partial');assert.equal(await originalChatBridgeCount(),0);
});

test('original Gemini response converter preserves tools, inline images and cached/thinking token usage',async()=>{
 await originalChatBridgeCount();
 for(const finishReason of ['STOP','MAX_TOKENS']){
  const body={candidates:[{finishReason,content:{parts:[{text:'answer'},{inlineData:{mimeType:'image/png',data:'AA=='}},{functionCall:{name:'lookup',args:{q:'hello'}}}]}}],usageMetadata:{promptTokenCount:12,cachedContentTokenCount:5,candidatesTokenCount:3,thoughtsTokenCount:2,candidatesTokensDetails:[{modality:'IMAGE',tokenCount:1}]}};
  const result=JSON.parse(globalThis.__s2aCompatCall(JSON.stringify({operation:'gemini_response',body,id:'gemini-test'})));
  assert.equal(result.error,undefined);const value=result.value;
  assert.equal(value.model,'gemini-test');assert.equal(value.content[0].text,'answer');
  assert.equal(value.content[1].text,'![image](data:image/png;base64,AA==)');
  assert.equal(value.content[2].type,'tool_use');assert.deepEqual(value.content[2].input,{q:'hello'});
  assert.equal(value.stop_reason,'tool_use');assert.equal(value.usage.input_tokens,7);assert.equal(value.usage.cache_read_input_tokens,5);assert.equal(value.usage.output_tokens,5);assert.equal(value.usage.image_output_tokens,1);
  const textOnly=JSON.parse(globalThis.__s2aCompatCall(JSON.stringify({operation:'gemini_response',id:'gemini-test',body:{...body,candidates:[{finishReason,content:{parts:[{text:'partial'}]}}]}}))).value;
  assert.equal(textOnly.stop_reason,finishReason==='MAX_TOKENS'?'max_tokens':'end_turn');
 }
});

test('original Gemini request converter preserves images, tool history, signatures and schema normalization',async()=>{
 await originalChatBridgeCount();
 const body={system:[{type:'text',text:'policy'}],messages:[
  {role:'user',content:[{type:'image',source:{type:'base64',media_type:'image/png',data:'AA=='}}]},
  {role:'assistant',content:[{type:'tool_use',id:'tool-1',name:'lookup',input:{q:'hello'}}]},
  {role:'user',content:[{type:'tool_result',tool_use_id:'tool-1',content:[{type:'text',text:'answer'},{type:'image',source:{type:'base64',media_type:'image/png',data:'AQ=='}}]}]},
 ],tools:[{name:'lookup',input_schema:{type:'object',additionalProperties:false,properties:{q:{type:'integer',exclusiveMinimum:0,enum:[1,2]}}}}],max_tokens:42,temperature:0.2,top_p:0.8,stop_sequences:['stop']};
 const result=JSON.parse(globalThis.__s2aCompatCall(JSON.stringify({operation:'gemini_request',body})));
 assert.equal(result.error,undefined);
 const value=result.value;
 assert.equal(value.systemInstruction.parts[0].text,'policy');
 assert.equal(value.contents[0].parts[0].inlineData.mimeType,'image/png');
 assert.equal(value.contents[1].role,'model');
 assert.equal(value.contents[1].parts[0].thoughtSignature,'skip_thought_signature_validator');
 assert.equal(value.contents[1].parts[0].functionCall.name,'lookup');
 assert.equal(value.contents[2].parts[0].functionResponse.name,'lookup');
 assert.equal(value.contents[2].parts[1].inlineData.data,'AQ==');
 const schema=value.tools[0].functionDeclarations[0].parameters;
 assert.equal(schema.type,'OBJECT');assert.equal(schema.additionalProperties,undefined);
 assert.equal(schema.properties.q.minimum,1);assert.deepEqual(schema.properties.q.enum,['1','2']);
 assert.equal(value.generationConfig.maxOutputTokens,42);assert.equal(value.generationConfig.temperature,0.2);
 assert.deepEqual(value.generationConfig.stopSequences,['stop']);
 assert.equal(await originalChatBridgeCount(),0);
});
