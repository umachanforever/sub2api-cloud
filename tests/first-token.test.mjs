import assert from 'node:assert/strict';
import test from 'node:test';
import {hasGeneratedToken,UsageObserver} from '../supabase/functions/subscription-api/stream.ts';
import {nativeResponse} from '../supabase/functions/subscription-api/api_key_provider.ts';
import {createHandler} from './handler.mjs';
import {encryptCredentials} from '../supabase/functions/subscription-api/credential_store.ts';
const encode=value=>new TextEncoder().encode('data: '+JSON.stringify(value)+'\n\n');
test('first-token detection excludes heartbeats, role announcements, empty deltas and usage-only records',()=>{
 for(const event of [{type:'ping'},{type:'response.created'},{type:'response.output_text.delta',delta:''},{choices:[{delta:{role:'assistant'}}]},{choices:[],usage:{completion_tokens:3}},{type:'message_start',message:{usage:{output_tokens:1}}},{type:'content_block_delta',delta:{type:'text_delta',text:''}},{usageMetadata:{candidatesTokenCount:3}},{type:'response.completed',response:{usage:{output_tokens:2}}}])assert.equal(hasGeneratedToken(event),false);
 for(const event of [{type:'response.output_text.delta',delta:'hi'},{type:'response.function_call_arguments.delta',delta:'{'},{choices:[{delta:{content:'hi'}}]},{choices:[{delta:{tool_calls:[{function:{arguments:'{'}}]}}]},{type:'content_block_delta',delta:{thinking:'thought'}},{type:'content_block_delta',delta:{partial_json:'{'}},{candidates:[{content:{parts:[{text:'hi'}]}}]},{candidates:[{content:{parts:[{functionCall:{name:'lookup',args:{}}}]}}]}])assert.equal(hasGeneratedToken(event),true);
});
test('Codex observes the first complete generation event once, including fragmented UTF-8 frames',()=>{
 const observer=new UsageObserver(Date.now()-1000);
 observer.push(encode({type:'response.created'}));assert.equal(observer.usage.firstTokenMs,undefined);
 const delta=encode({type:'response.output_text.delta',delta:'你好'});
 observer.push(delta.slice(0,delta.length-4));assert.equal(observer.usage.firstTokenMs,undefined);
 observer.push(delta.slice(delta.length-4));const first=observer.usage.firstTokenMs;assert.ok(first>=1000&&first<10000);
 observer.push(encode({type:'response.output_text.delta',delta:'again'}));observer.end();assert.equal(observer.usage.firstTokenMs,first);
});
test('tool names are generation while empty tool objects are not, and clock bounds preserve zero',()=>{
 assert.equal(hasGeneratedToken({choices:[{delta:{tool_calls:[{function:{name:'lookup'}}]}}]}),true);
 assert.equal(hasGeneratedToken({choices:[{delta:{function_call:{name:'lookup'}}}]}),true);
 assert.equal(hasGeneratedToken({candidates:[{content:{parts:[{functionCall:{}}]}}]}),false);
 for(const [start,expected] of [[Date.now()+1000,0],[0,2147483647]]) {
  const observer=new UsageObserver(start);observer.push(encode({type:'response.output_text.delta',delta:'hi'}));assert.equal(observer.usage.firstTokenMs,expected);
 }
});
test('native streaming protocols capture measured latency while non-streaming results keep it unknown',async()=>{
 for(const [platform,protocol,control,delta,done] of [
  ['openai','chat',{choices:[{delta:{role:'assistant'}}]},{choices:[{delta:{content:'hi'}}]},{choices:[{finish_reason:'stop'}]}],
  ['openai','responses',{type:'response.created'},{type:'response.output_text.delta',delta:'hi'},{type:'response.completed',response:{usage:{input_tokens:1,output_tokens:1}}}],
  ['anthropic','messages',{type:'ping'},{type:'content_block_delta',delta:{text:'hi'}},{type:'message_stop'}],
  ['gemini','gemini',{usageMetadata:{promptTokenCount:1}},{candidates:[{content:{parts:[{text:'hi'}]}}]},{candidates:[{finishReason:'STOP'}]}],
 ]) {
  let usage;
  const bytes=new Uint8Array([...encode(control),...encode(delta),...encode(done)]);
  const response=await nativeResponse(new Response(bytes,{headers:{'content-type':'text/event-stream'}}),platform,protocol,true,new AbortController().signal,'request',async(status,value)=>{assert.equal(status,200);usage=value;},'',undefined,undefined,undefined,Date.now()-1000);
  await response.text();assert.ok(usage.firstTokenMs>=1000&&usage.firstTokenMs<10000,platform+protocol);
 }
 let usage;
 const response=await nativeResponse(Response.json({choices:[{finish_reason:'stop',message:{content:'hi'}}]}),'openai','chat',false,new AbortController().signal,'request',async(status,value)=>{usage=value;});
 assert.equal(response.status,200);assert.equal(usage.firstTokenMs,undefined);
});

test('the gateway forwards measured first-token latency to settlement',async()=>{
 const account=crypto.randomUUID(),lease=crypto.randomUUID();
 const config={url:'https://db',serviceKey:'service',encryptionKey:Buffer.alloc(32,8).toString('base64'),adminIds:[]};
 const encrypted=await encryptCredentials({api_key:'private-key'},config.encryptionKey);
 let settled;
 const handler=createHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_acquire'))return Response.json({lease_id:lease,account:{id:account,...encrypted,type:'apikey',platform:'openai',credential_version:1}});
  if(String(url).endsWith('/s2a_finish')){settled=JSON.parse(init.body);return Response.json(null);}
  assert.equal(new URL(url).hostname,'api.openai.com');
  return new Response(new Uint8Array([...encode({choices:[{delta:{content:'hi'}}]}),...encode({choices:[{finish_reason:'stop'}]})]),{headers:{'content-type':'text/event-stream'}});
 });
 const response=await handler(new Request('https://gateway/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer gateway-key','content-type':'application/json'},body:JSON.stringify({model:'gpt-4.1',messages:[{role:'user',content:'hi'}],stream:true})}));
 assert.equal(response.status,200);await response.text();assert.ok(Number.isInteger(settled.p_first_token_ms)&&settled.p_first_token_ms>=0);assert.equal(settled.p_lease_id,lease);
});
