import test from 'node:test';
import assert from 'node:assert/strict';
import {enableChatImages,chatImageMarkdown,IMAGE_CHAT_FRAME_LIMIT} from '../supabase/functions/sub2api/chat_images.ts';
import {chatToResponses,responseToChat,streamChat,completedResponse} from '../supabase/functions/sub2api/openai_protocol.ts';
import {UsageObserver} from '../supabase/functions/sub2api/stream.ts';
/** Synthetic, decodable one-pixel PNG; never a provider response capture. */
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAaX2RaAAAAAASUVORK5CYII=';
const image={type:'image_generation_call',id:'image-1',status:'completed',result:png,output_format:'png'};
const source=events=>new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')).body;
test('chat image tools preserve caller options, search and tool choice',()=>{
 const body={tools:[{type:'web_search'}],tool_choice:'none',instructions:'original'};enableChatImages(body);enableChatImages(body);
 assert.equal(body.tools.length,2);assert.equal(body.tools[1].model,'gpt-image-2');assert.equal(body.tool_choice,'none');assert.match(body.instructions,/original/);
});
test('JSON chat returns generated image markdown alongside text',()=>{
 const result=responseToChat({output:[{type:'message',content:[{type:'output_text',text:'Here'}]},image]},'id');
 assert.match(result.choices[0].message.content,/Here/);assert.ok(result.choices[0].message.content.includes('![Generated image](data:image/png;base64,'+png+')'));
});
test('stream emits images once for both item-done and terminal-only upstreams',async()=>{
 for(const itemDone of [false,true]){
  const events=[{type:'response.output_text.delta',delta:'Here'},...(itemDone?[{type:'response.output_item.done',output_index:1,item:image}]:[]),{type:'response.completed',response:{status:'completed',output:[image]}}];
  const text=await new Response(streamChat(source(events),'id','gpt-6.1-sol',false,IMAGE_CHAT_FRAME_LIMIT)).text();
  assert.equal(text.split('data:image/png').length-1,1);assert.ok(text.includes('[DONE]'));
 }
});
test('image-sized completion frames preserve output and usage',async()=>{
 const large={...image,result:'a'.repeat(2*1024*1024)};
 const event={type:'response.completed',response:{status:'completed',output:[large],usage:{input_tokens:12,output_tokens:34}}};
 const observer=new UsageObserver(Date.now(),IMAGE_CHAT_FRAME_LIMIT);observer.push(new TextEncoder().encode('data: '+JSON.stringify(event)+'\n\n'));observer.end();
 assert.equal(observer.usage.outcome,'completed');assert.equal(observer.usage.output,34);
 const result=await completedResponse(source([event]),IMAGE_CHAT_FRAME_LIMIT);assert.equal(result.output[0].result.length,large.result.length);
});

test('chat proxy offers image tools only with explicit group permission',async()=>{
 const {createHandler}=await import('./handler.mjs');
 for(const allowed of [false,true,"json_object"]){
  let dispatched=false;
  const handler=createHandler({url:'https://db.invalid',serviceKey:'service',encryptionKey:'',adminIds:[],dataModel:'native'},async(url,init)=>{
   if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',allow_image_generation:allowed!==false,account:{id:'1',type:'oauth',platform:'openai',credential_version:1,credential_storage:'vault',codex_settings:{auto_sync:'false'},credentials:{access_token:'private',chatgpt_account_id:'account'}}});
   if(String(url).endsWith('/s2a_personal_finish'))return Response.json(null);
   assert.ok(!String(url).includes('/storage/'),'chat output must not depend on storage');
   assert.ok(String(url).includes('/responses'));const payload=JSON.parse(init.body);dispatched=true;
   assert.equal(payload.tools.some(t=>t.type==='image_generation'),allowed===true);assert.ok(payload.tools.some(t=>t.type==='web_search'));
   return new Response(source([{type:'response.completed',response:{status:'completed',output:allowed===true?[image]:[{type:'message',content:[{type:'output_text',text:'OK'}]}],usage:{input_tokens:1,output_tokens:2}}}]),{headers:{'content-type':'text/event-stream'}});
  });
  const response=await handler(new Request('https://edge/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer client','content-type':'application/json'},body:JSON.stringify({model:'gpt-6.1-sol',messages:[{role:'user',content:'Draw an image'}],...(allowed==='json_object'?{response_format:{type:'json_object'}}:{}),stream:false})}));
  const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.ok(dispatched);assert.equal(result.choices[0].message.content.includes('data:image/png;base64,'+png),allowed===true);
 }
});
test('generated image history becomes visual input for follow-up edits',()=>{
 const body={input:[{role:'assistant',content:[{type:'output_text',text:'Here\n![Generated image](data:image/png;base64,aGVsbG8=)'}]},{role:'user',content:[{type:'input_text',text:'Make it blue'}]}]};
 enableChatImages(body);assert.equal(body.input.length,3);assert.equal(body.input[0].content[0].text.includes('aGVsbG8='),false);assert.equal(body.input[1].content[1].image_url,'data:image/png;base64,aGVsbG8=');assert.equal(body.input[2].content[0].text,'Make it blue');
});

test('partial terminal output retains previously completed images without duplicates',async()=>{
 const message={id:'message-1',type:'message',content:[{type:'output_text',text:'Done'}]};
 for(const final of [[message],[image,message]]){
  const completed=await completedResponse(source([{type:'response.output_item.done',output_index:0,item:image},{type:'response.completed',response:{status:'completed',output:final}}]));
  const content=responseToChat(completed,'id').choices[0].message.content;
  assert.equal(content.split('data:image/png').length-1,1);assert.ok(content.includes('Done'));
 }
});
test('failed or empty image results fail both JSON and streaming responses',async()=>{
 for(const broken of [{type:'image_generation_call',status:'failed',error:{message:'private failure'}},{type:'image_generation_call',status:'completed',result:''}]){
  assert.throws(()=>responseToChat({output:[broken]},'id'));
  const events=[{type:'response.output_item.done',output_index:0,item:broken},{type:'response.completed',response:{status:'completed',output:[broken]}}];
  const result=await new Response(streamChat(source(events),'id','gpt-6.1-sol')).text();
  assert.ok(result.includes('upstream_error'));assert.ok(!result.includes('[DONE]'));assert.ok(!result.includes('private failure'));
 }
});
test('JSON and JSON-schema requests never gain image tools or image instructions',()=>{
 for(const type of ['json_object','json_schema']){
  const body={text:{format:{type}},tools:[{type:'web_search'}],instructions:'JSON only'};
  enableChatImages(body);assert.deepEqual(body.tools,[{type:'web_search'}]);assert.equal(body.instructions,'JSON only');
 }
});
test('unexpected upstream image output cannot corrupt structured JSON',async()=>{
 assert.throws(()=>responseToChat({output:[image]},'id',true));
 const result=await new Response(streamChat(source([{type:'response.completed',response:{status:'completed',output:[image]}}]),'id','gpt-6.1-sol',false,IMAGE_CHAT_FRAME_LIMIT,true)).text();
 assert.ok(result.includes('upstream_error'));assert.ok(!result.includes('data:image/'));
});

test('signed generated image history becomes visual input for follow-up edits',()=>{
 const url='https://project.supabase.co/storage/v1/object/sign/sub2api-artifacts/images/imgtask_'+'a'.repeat(32)+'/image-1.png?token=signed';
 const body={input:[{role:'assistant',content:[{type:'output_text',text:'![Generated image]('+url+')'}]}]};
 enableChatImages(body);assert.equal(body.input.length,2);assert.equal(body.input[1].content[1].image_url,url);assert.equal(body.input[0].content[0].text,'[Previously generated image]');
});

test('actual image bytes determine MIME even with absent or incorrect output_format',()=>{
 for(const output_format of [undefined,'jpeg','webp']){
  assert.equal(chatImageMarkdown({...image,output_format}),'\n\n![Generated image](data:image/png;base64,'+png+')\n\n');
 }
 // Synthetic signatures exercise format detection, not full decoder validation.
 for(const [mime,bytes] of [['jpeg',[255,216,255,0]],['webp',Buffer.from('RIFF0000WEBP')],['gif',Buffer.from('GIF89a')]]){
  const result=Buffer.from(bytes).toString('base64');
  assert.ok(chatImageMarkdown({...image,result}).includes('data:image/'+mime+';base64,'+result));
 }
 const chat_image_url='https://project.supabase.co/storage/v1/object/sign/sub2api-artifacts/images/imgtask_'+'a'.repeat(32)+'/image-1.png?token=signed';
 assert.ok(chatImageMarkdown({...image,chat_image_url}).includes('data:image/png'));
 assert.ok(chatImageMarkdown({...image,result:undefined,chat_image_url}).includes(chat_image_url));
});

test('invalid, noncanonical and oversized bytes fail instead of becoming broken images',async()=>{
 const invalid=['aGVsbG8=','!!!!','iVBORw0KGgo',png+'=',Buffer.from('<svg>unsafe</svg>').toString('base64'),'a'.repeat(Math.ceil(20*1024*1024/3)*4+4)];
 for(const result of invalid)assert.throws(()=>chatImageMarkdown({...image,result}));
 for(const result of invalid.slice(0,-1)){
  const text=await new Response(streamChat(source([{type:'response.completed',response:{status:'completed',output:[{...image,result}]}}]),'id','gpt-6-luna',false,IMAGE_CHAT_FRAME_LIMIT)).text();
  assert.ok(text.includes('upstream_error'));assert.ok(!text.includes('[DONE]'));assert.ok(!text.includes('![Generated image]'));
 }
});

test('string assistant history round-trips through chat conversion as visual input',()=>{
 const input={model:'gpt-6-luna',messages:[{role:'assistant',content:chatImageMarkdown(image)},{role:'user',content:'Make it blue'}]};
 const body=chatToResponses(input);enableChatImages(body);
 assert.equal(body.input.length,3);assert.ok(!JSON.stringify(body.input[0]).includes(png));
 assert.equal(body.input[1].content[1].image_url,'data:image/png;base64,'+png);
 assert.equal(body.input[2].content,'Make it blue');
 const plain={input:[{role:'assistant',content:'No images'}]};enableChatImages(plain);assert.equal(plain.input[0].content,'No images');
});

test('full OAuth chat route returns the same inline image in JSON and SSE without storage',async()=>{
 const {createHandler}=await import('./handler.mjs');
 for(const stream of [false,true])for(const itemDone of [false,true]){
  let finishes=0;
  const handler=createHandler({url:'https://db.invalid',serviceKey:'service',encryptionKey:'',adminIds:[],dataModel:'native'},async(url)=>{
   if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',allow_image_generation:true,account:{id:'1',type:'oauth',platform:'openai',credential_version:1,credential_storage:'vault',codex_settings:{auto_sync:'false'},credentials:{access_token:'private',chatgpt_account_id:'account'}}});
   if(String(url).endsWith('/s2a_personal_finish')){finishes++;return Response.json(null);}
   assert.ok(String(url).includes('/responses'),'unexpected storage or RPC access');
   return new Response(source([...(itemDone?[{type:'response.output_item.done',output_index:0,item:image}]:[]),{type:'response.completed',response:{status:'completed',output:[image],usage:{input_tokens:1,output_tokens:2}}}]),{headers:{'content-type':'text/event-stream'}});
  });
  const response=await handler(new Request('https://edge/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer client','content-type':'application/json'},body:JSON.stringify({model:'gpt-6-luna',messages:[{role:'user',content:'Draw an image'}],stream})}));
  assert.equal(response.status,200);
  let content;
  if(stream){
   const text=await response.text();assert.ok(text.includes('[DONE]'));assert.ok(!text.includes('upstream_error'));
   content=text.split('\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6))).map(chunk=>chunk.choices?.[0]?.delta?.content??'').join('');
  }else content=(await response.json()).choices[0].message.content;
  assert.equal(content,chatImageMarkdown(image));assert.equal(finishes,1);
 }
});
