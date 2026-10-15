import assert from 'node:assert/strict';
import test from 'node:test';
import {originalChatBridgeCount} from '../supabase/functions/sub2api/original_chat_bridge.ts';

function call(operation,body,id){
  const result=JSON.parse(globalThis.__s2aCompatCall(JSON.stringify({operation,body,id})));
  assert.equal(result.error,undefined);
  return result.value;
}

test('original Anthropic WASM preserves tools and cached usage in stream and JSON conversion',async()=>{
  await originalChatBridgeCount();
  const opened=call('open_anthropic',{model:'claude-test',input:'hello',instructions:'policy',tools:[{type:'custom',name:'exec'}],max_output_tokens:42});
  try{
    assert.equal(opened.body.stream,true);
    assert.equal(opened.body.max_tokens,42);
    assert.equal(opened.body.tools[0].name,'exec');
    const sequence=[
      {type:'message_start',message:{id:'msg-test',model:'claude-test',role:'assistant',content:[],usage:{input_tokens:2,cache_read_input_tokens:3,cache_creation_input_tokens:4}}},
      {type:'content_block_start',index:0,content_block:{type:'tool_use',id:'toolu_1',name:'exec',input:{input:'echo hello'}}},
      {type:'content_block_stop',index:0},
      {type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:5}},
      {type:'message_stop'},
    ];
    const events=sequence.flatMap(event=>call('chunk_anthropic',event,opened.id)??[]);
    assert.deepEqual(call('finish_anthropic',undefined,opened.id)??[],[]);
    const completed=events.find(event=>event.type==='response.completed').response;
    assert.equal(completed.output[0].type,'custom_tool_call');
    assert.equal(completed.output[0].input,'echo hello');
    assert.equal(completed.usage.input_tokens,9);
    assert.equal(completed.usage.output_tokens,5);
    assert.equal(completed.usage.input_tokens_details.cached_tokens,3);
    const json=call('json_anthropic',{id:'msg-json',model:'claude-test',content:[{type:'tool_use',id:'toolu_2',name:'exec',input:{input:'pwd'}}],stop_reason:'tool_use',usage:{input_tokens:2,output_tokens:1}},opened.id);
    assert.equal(json.output[0].type,'custom_tool_call');
    assert.equal(json.output[0].input,'pwd');
  }finally{call('close',undefined,opened.id);}
  assert.equal(await originalChatBridgeCount(),0);
});

test('original Anthropic WASM rejects streams without terminal metadata',async()=>{
  await originalChatBridgeCount();
  const opened=call('open_anthropic',{model:'claude-test',input:'hello'});
  try{
    const result=JSON.parse(globalThis.__s2aCompatCall(JSON.stringify({operation:'finish_anthropic',id:opened.id})));
    assert.equal(result.error,'conversion_failed');
    const stopped=JSON.parse(globalThis.__s2aCompatCall(JSON.stringify({operation:'chunk_anthropic',id:opened.id,body:{type:'message_stop'}})));
    assert.equal(stopped.error,'conversion_failed');
  }finally{call('close',undefined,opened.id);}
  assert.equal(await originalChatBridgeCount(),0);
});
