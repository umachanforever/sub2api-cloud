import test from 'node:test';
import assert from 'node:assert/strict';
import {publishChatMedia,cleanupChatMedia} from '../supabase/functions/sub2api/chat_media.ts';
import {completedResponse,responseToChat} from '../supabase/functions/sub2api/openai_protocol.ts';
const image={type:'image_generation_call',id:'img-1',status:'completed',result:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAaX2RaAAAAAASUVORK5CYII=',output_format:'png'};
const source=events=>new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
test('chat images upload once, stay private and use seven-day HTTPS signatures',async()=>{
 let uploads=0,registered=0,signed=0;
 const db={config:{url:'https://project.supabase.co',serviceKey:'private'},rpc:async(name,args)=>{assert.equal(name,'s2a_chat_media_register');assert.equal(args.p_lease_id,'lease');registered++;return true;},fetchImpl:async(url,init)=>{
  if(url.includes('/object/sign/')){signed++;assert.equal(JSON.parse(init.body).expiresIn,604800);return Response.json({signedURL:new URL(url).pathname.replace('/storage/v1','')+'?token=capability'});}
  uploads++;assert.equal(init.body.length,Buffer.from(image.result,'base64').length);return Response.json({});
 }};
 const upstream=source([{type:'response.output_item.done',output_index:0,item:image},{type:'response.completed',response:{status:'completed',output:[image]}}]);
 const completed=await completedResponse(publishChatMedia(db,upstream,'lease',new AbortController().signal).body);
 const content=responseToChat(completed,'id').choices[0].message.content;
 assert.ok(content.includes('https://project.supabase.co/storage/v1/object/sign/'));assert.ok(!content.includes('base64'));assert.ok(!content.includes('private'));assert.equal(uploads,1);assert.equal(signed,1);assert.equal(registered,1);
});
test('failed image permissions fail before storage upload',async()=>{
 const db={rpc:async()=>false,fetchImpl:()=>assert.fail('upload forbidden')};
 const body=publishChatMedia(db,source([{type:'response.output_item.done',output_index:0,item:image}]),'lease',new AbortController().signal).body;
 await assert.rejects(new Response(body).text(),/image_generation_forbidden/);
});
test('expired chat media is deleted before removing its cleanup record',async()=>{
 const path='images/imgtask_'+'a'.repeat(32)+'/image-1.png',calls=[];
 const db={config:{url:'https://project.supabase.co',serviceKey:'private'},rpc:async(name)=>{calls.push(name);return name==='s2a_chat_media_expired'?[path]:null;},fetchImpl:async()=>{calls.push('delete');return Response.json({});}};
 assert.equal(await cleanupChatMedia(db),1);assert.deepEqual(calls,['s2a_chat_media_expired','delete','s2a_chat_media_deleted']);
});
