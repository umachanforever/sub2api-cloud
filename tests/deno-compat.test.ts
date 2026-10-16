import {originalGeminiBridge,originalChatBridgeCount,originalCodexMetadata,originalFastPolicy} from '../supabase/functions/sub2api/original_chat_bridge.ts';

Deno.test('Deno loads compressed original converters with scoped file permission',async()=>{
 const bridge=await originalGeminiBridge({model:'gemini-test',input:'hello'},'deno-runtime');
 try{
  if(bridge.body.contents[0].parts[0].text!=='hello')throw Error('Request conversion failed');
  const upstream={candidates:[{finishReason:'STOP',content:{parts:[{text:'hello from Gemini'}]}}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:2}};
  const text=await bridge.response(new Response('data: '+JSON.stringify(upstream)+'\n\n',{headers:{'content-type':'text/event-stream'}})).text();
  const terminal=text.split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5))).find(event=>event.type==='response.completed');
  if(terminal?.response.output[0]?.content[0]?.text!=='hello from Gemini'||terminal.response.usage.input_tokens!==3)throw Error('Stream conversion failed');
 }finally{bridge.close();}
 if(await originalChatBridgeCount()!==0)throw Error('Converter state leaked');
});
Deno.test('Deno executes original Go catalog metadata intersections',async()=>{
 const model=await originalCodexMetadata({model:'public',descriptor:{context_window:9999},candidates:[{context_window:1000,max_context_window:2000,codex_tool_capabilities:{supports_search_tool:true}},{context_window:500,max_context_window:1000,codex_tool_capabilities:{supports_search_tool:false}}]});
 if(model.context_window!==500||model.max_context_window!==1000||model.supports_search_tool!==false)throw Error('Metadata intersection failed');
 if(await originalChatBridgeCount()!==0)throw Error('Metadata conversion allocated stream state');
});

Deno.test('Deno executes original Go fast policy parsing without stream state',async()=>{
 const input={settings_json:'{"rules":[{"action":"block"},{"user_ids":[9007199254740993],"action":"filter"}]}',user_id:'9007199254740993',account_type:'apikey',model:'gpt-6-sol',tier:' FAST '};
 if((await originalFastPolicy(input)).action!=='filter')throw Error('Original user-scoped rule failed');
 if((await originalFastPolicy({...input,settings_json:'{"rules":[{"user_ids":["7"],"action":"block"}]}'})).action!=='pass')throw Error('Corrupt typed settings did not use default');
 if(await originalChatBridgeCount()!==0)throw Error('Policy evaluation allocated stream state');
});
