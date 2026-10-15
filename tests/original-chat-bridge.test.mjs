import assert from 'node:assert/strict';
import test from 'node:test';
import {originalChatBridge,originalChatBridgeCount} from '../supabase/functions/sub2api/original_chat_bridge.ts';
import {UsageObserver} from '../supabase/functions/sub2api/stream.ts';

const body=()=>({model:'deepseek-test',input:'hello'});
function upstream(chunks,split=false){
  const bytes=new TextEncoder().encode(chunks.map(chunk=>`data: ${typeof chunk==='string'?chunk:JSON.stringify(chunk)}\r\n\r\n`).join(''));
  let offset=0;
  return new Response(new ReadableStream({pull(controller){if(offset===bytes.length)controller.close();else{const end=split?offset+1:bytes.length;controller.enqueue(bytes.slice(offset,end));offset=end;}}}),{headers:{'content-type':'text/event-stream'}});
}
async function events(response){
  const text=await response.text(),observer=new UsageObserver();observer.push(new TextEncoder().encode(text));observer.end();
  return {values:text.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5))),usage:observer.usage};
}

test('original Go request conversion preserves instruction roles, reasoning/tool history, images and executable tools',async()=>{
  const bridge=await originalChatBridge({model:'deepseek-test',instructions:'policy',input:[
    {role:'developer',content:'additional policy'},
    {role:'user',content:[{type:'input_text',text:'look'},{type:'input_image',image_url:'data:image/png;base64,AA=='}]},
    {type:'reasoning',summary:[{type:'summary_text',text:'prior reasoning'}]},
    {type:'function_call',call_id:'call',name:'lookup',namespace:'tools',arguments:'{}'},
    {type:'function_call_output',call_id:'call',output:{answer:42}},
    {role:'developer',content:'new instructions'},
    {type:'additional_tools',tools:[{type:'custom',name:'exec'}]},
  ],tools:[{type:'namespace',name:'tools',tools:[{type:'function',name:'lookup',parameters:{type:'object'},strict:true}]}],max_output_tokens:20,temperature:0.2,text:{format:{type:'json_schema',name:'answer',schema:{type:'object'},strict:true}}},'scope');
  try{
    assert.equal(bridge.body.messages[0].content,'policy\n\nadditional policy');
    assert.equal(bridge.body.messages[1].content[1].image_url.url,'data:image/png;base64,AA==');
    const assistant=bridge.body.messages.find(message=>message.tool_calls);
    assert.equal(assistant.reasoning_content,'prior reasoning');assert.equal(assistant.tool_calls[0].function.name,'tools__lookup');
    assert.equal(bridge.body.messages.find(message=>message.role==='tool').content,'{"answer":42}');
    assert.equal(bridge.body.messages.at(-1).role,'user');
    assert.deepEqual(bridge.body.tools.map(tool=>tool.function.name),['tools__lookup','exec']);
    assert.equal(bridge.body.max_completion_tokens,20);assert.equal(bridge.body.temperature,0.2);assert.equal(bridge.body.response_format.json_schema.strict,true);
    assert.deepEqual(bridge.body.stream_options,{include_usage:true});
  }finally{bridge.close();}
  assert.equal(await originalChatBridgeCount(),0);
});

test('original Go streaming restores custom and namespace tools, reasoning IDs and cache usage across split UTF-8 frames',async()=>{
  const bridge=await originalChatBridge({...body(),tools:[{type:'custom',name:'exec'},{type:'namespace',name:'tools',tools:[{type:'function',name:'lookup',parameters:{type:'object'}}]}]},'reasoning-owner');
  const result=await events(bridge.response(upstream([
    {id:'chat-original',choices:[{index:0,delta:{role:'assistant',reasoning_content:'考虑一下'},finish_reason:null}]},
    {choices:[{index:0,delta:{tool_calls:[{index:0,id:'call-a',type:'function',function:{name:'exec',arguments:'{"input":"echo'}}]},finish_reason:null}]},
    {choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:' hello"}'}},{index:1,id:'call-b',type:'function',function:{name:'tools__lookup',arguments:'{"q":"hi"}'}}]},finish_reason:null}]},
    {choices:[{index:0,delta:{},finish_reason:'tool_calls'}]},
    {choices:[],usage:{prompt_tokens:12,completion_tokens:5,prompt_tokens_details:{cached_tokens:7}}},'[DONE]',
  ],true)));
  const response=result.values.find(event=>event.type==='response.completed').response;
  assert.equal(response.id,'chat-original');
  const custom=response.output.find(item=>item.type==='custom_tool_call'),namespaced=response.output.find(item=>item.namespace==='tools'),reasoning=response.output.find(item=>item.type==='reasoning');
  assert.equal(custom.input,'echo hello');assert.equal(custom.call_id,'call-a');assert.equal(namespaced.name,'lookup');assert.equal(namespaced.call_id,'call-b');
  assert.equal(reasoning.summary[0].text,'考虑一下');assert.equal(result.usage.input,12);assert.equal(result.usage.output,5);assert.equal(result.usage.cacheRead,7);assert.equal(result.usage.outcome,'completed');
  const history=[{type:'reasoning',id:reasoning.id,encrypted_content:'opaque'},{type:'function_call',call_id:'next',name:'lookup',arguments:'{}'},{type:'function_call_output',call_id:'next',output:'ok'}];
  for(const [scope,expected] of [['reasoning-owner','考虑一下'],['different-owner',undefined]]){
    const next=await originalChatBridge({...body(),input:history},scope);
    try{assert.equal(next.body.messages.find(message=>message.tool_calls).reasoning_content,expected);}finally{next.close();}
  }
  assert.equal(await originalChatBridgeCount(),0);
});

test('original bridge retains usage when rejecting truncated tool arguments and hides upstream error content',async()=>{
  for(const failure of ['arguments','error']){
    const bridge=await originalChatBridge(body(),'scope');
    const chunks=[{choices:[{index:0,delta:{tool_calls:[{index:0,id:'call',type:'function',function:{name:'lookup',arguments:'{"truncated":'}}]},finish_reason:'tool_calls'}]},{choices:[],usage:{prompt_tokens:4,completion_tokens:2}}];
    if(failure==='error')chunks.push({error:{message:'private credential detail'}});
    const result=await events(bridge.response(upstream(chunks)));
    assert.equal(result.values.at(-1).type,'response.failed');assert.equal(result.usage.outcome,'failed');assert.equal(result.usage.input,4);assert.equal(result.usage.output,2);
    assert.equal(JSON.stringify(result.values).includes('private credential detail'),false);assert.equal(result.values.some(event=>event.type==='response.completed'),false);
  }
  assert.equal(await originalChatBridgeCount(),0);
});

test('original bridge preserves length limits and accepts provider JSON fallbacks',async()=>{
  for(const json of [false,true]){
    const bridge=await originalChatBridge(body(),'scope');
    const response=json?Response.json({choices:[{index:0,message:{role:'assistant',content:'partial'},finish_reason:'length'}],usage:{prompt_tokens:2,completion_tokens:1}}):upstream([{choices:[{index:0,delta:{content:'partial'},finish_reason:'length'}]},{choices:[],usage:{prompt_tokens:2,completion_tokens:1}},'[DONE]']);
    const result=await events(bridge.response(response));assert.equal(result.values.at(-1).response.status,'incomplete');assert.equal(result.usage.outcome,'incomplete');assert.equal(result.usage.input,2);
  }
  assert.equal(await originalChatBridgeCount(),0);
});

test('cancelled original bridges close pending upstream reads and release their Go state',async()=>{
  let cancelled=false;
  const bridge=await originalChatBridge(body(),'scope');
  const response=bridge.response(new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}}));
  assert.equal(await originalChatBridgeCount(),1);await response.body.cancel();assert.equal(cancelled,true);assert.equal(await originalChatBridgeCount(),0);
});

test('original tool collisions fail before stream allocation and conversion state stays bounded',async()=>{
  await assert.rejects(originalChatBridge({...body(),tools:[{type:'custom',name:'duplicate'},{type:'function',name:'duplicate'}]},'scope'),error=>error.status===400);
  assert.equal(await originalChatBridgeCount(),0);
  const bridges=[];
  try{for(let i=0;i<32;i++)bridges.push(await originalChatBridge(body(),'scope'));await assert.rejects(originalChatBridge(body(),'scope'),error=>error.status===503);}
  finally{for(const bridge of bridges)bridge.close();}
  assert.equal(await originalChatBridgeCount(),0);
});
