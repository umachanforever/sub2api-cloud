import {originalGeminiBridge,originalChatBridgeCount} from '../supabase/functions/sub2api/original_chat_bridge.ts';

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
