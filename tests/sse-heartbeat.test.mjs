import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {createHandler} from './handler.mjs';
import {sseHeartbeat} from '../supabase/functions/sub2api/sse_heartbeat.ts';

const encoder=new TextEncoder();
const frame=value=>encoder.encode('data: '+JSON.stringify(value)+'\n\n');
const config={url:'https://db.invalid',serviceKey:'service',encryptionKey:'',adminIds:[],dataModel:'native'};

test('chat image generation keeps an idle SSE connection alive until the real finish reason',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let upstream,reads=0,cancelled=0;
 const app=createHandler(config,async url=>{
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',allow_image_generation:true,account:{id:'1',type:'oauth',platform:'openai',credential_storage:'vault',credentials:{access_token:'private',chatgpt_account_id:'account'},codex_settings:{auto_sync:'false'}}});
  if(String(url).endsWith('/s2a_personal_finish'))return Response.json(null);
  if(String(url).includes('/rest/v1/rpc/'))return Response.json(true);
  return new Response(new ReadableStream({start(controller){upstream=controller;controller.enqueue(frame({type:'response.created',response:{model:'gpt-6.1'}}));},pull(){reads++;},cancel(){cancelled++;}}),{headers:{'content-type':'text/event-stream'}});
 });
 const response=await app(new Request('https://edge/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer client','content-type':'application/json'},body:JSON.stringify({model:'gpt-6.1',stream:true,messages:[{role:'user',content:'Generate a spring photo'}]})}));
 assert.equal(response.status,200);const reader=response.body.getReader();
 try{
  const initial=await reader.read();assert.ok(initial.value.length);
  // Advance time without waiting for a real minute-long image generation.
  for(let n=0;n<5;n++){
   const waiting=reader.read();await setImmediate();t.mock.timers.tick(15_000);await setImmediate();
   const result=await Promise.race([waiting,Promise.resolve('idle disconnect')]);
   assert.notEqual(result,'idle disconnect','idle clients must receive a frame while the image is generating');
   const text=new TextDecoder().decode(result.value);
   // The initial assistant-role chunk may follow an immediate heartbeat.
   assert.ok(text.startsWith(':')||text.includes('"role":"assistant"'));
   assert.ok(!text.includes('"finish_reason":"stop"'),'heartbeats cannot report generation success');
  }
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAaX2RaAAAAAASUVORK5CYII=';
  upstream.enqueue(frame({type:'response.completed',response:{status:'completed',output:[{type:'image_generation_call',id:'image-1',status:'completed',result:png},{type:'message',content:[{type:'output_text',text:'Ready'}]}]}}));upstream.close();
  let tail='';for(;;){const part=await reader.read();if(part.done)break;tail+=new TextDecoder().decode(part.value);}
  assert.match(tail,/data:image\/png;base64,/);assert.match(tail,/"finish_reason":"stop"/);assert.match(tail,/data: \[DONE\]/);assert.ok(reads<10,'heartbeats must not create concurrent upstream reads');
 }finally{await reader.cancel();}
 assert.equal(cancelled,0);
});

test('SSE heartbeats retain one pending read and cancel it without leaving a timer',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let pulls=0,cancelled=0;
 const source=new ReadableStream({pull(){pulls++;},cancel(){cancelled++;}});
 const reader=sseHeartbeat(source,100).getReader();
 for(let n=0;n<3;n++){
  const waiting=reader.read();await setImmediate();t.mock.timers.tick(100);await setImmediate();
  assert.equal(new TextDecoder().decode((await waiting).value),': keep-alive\n\n');
 }
 // ReadableStream may prefetch once before the wrapper acquires its reader.
 assert.ok(pulls<=2);const pending=reader.read();await setImmediate();
 await reader.cancel();assert.equal((await pending).done,true);assert.equal(cancelled,1);
 t.mock.timers.tick(1000);assert.equal((await reader.read()).done,true);
});

test('SSE heartbeats preserve bytes and propagate errors without adding a success marker',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let upstream;
 const reader=sseHeartbeat(new ReadableStream({start(controller){upstream=controller;}}),100).getReader();
 const waiting=reader.read();await setImmediate();t.mock.timers.tick(100);await setImmediate();await waiting;
 const bytes=frame({error:{code:'upstream_error',message:'Generation failed'}});
 upstream.enqueue(bytes);assert.deepEqual((await reader.read()).value,bytes);
 upstream.error(new Error('upstream closed'));await assert.rejects(reader.read(),/upstream closed/);
 t.mock.timers.tick(1000);
});
