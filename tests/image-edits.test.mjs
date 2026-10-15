import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackendHandler} from './handler.mjs';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
import {imageResponses} from '../supabase/functions/sub2api/image_responses.ts';
import {imageForm} from '../supabase/functions/sub2api/image_input.ts';
const config={url:'https://database.invalid',serviceKey:'private',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
async function fixture(forward,{type="apikey",upstreamModel="gpt-image-2"}={}){
 const stored=await encryptCredentials(type==='apikey'?{api_key:'provider-key'}:{access_token:'oauth-private',refresh_token:'refresh-private',expires_at:Date.now()+3600000,chatgpt_account_id:'chatgpt-account'},config.encryptionKey),leases=[],finishes=[];
 const handler=createBackendHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_key_policy'))return Response.json({platform:'openai'});
  if(String(url).endsWith('/s2a_personal_acquire')){leases.push(JSON.parse(init.body));return Response.json({lease_id:'lease',upstream_model:upstreamModel,account:{...stored,id:'1',platform:'openai',type,credential_version:1}});}
  if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
  if(String(url).includes('/rpc/'))return Response.json(null);
  return forward(String(url),init);
 });return {handler,leases,finishes};
}
const output={created:1,data:[{b64_json:'aW1hZ2U='}],usage:{input_tokens:12,output_tokens:7,input_tokens_details:{cached_tokens:2}}};
test('JSON image editing preserves input URLs, masks and provider extensions with authenticated mapped dispatch',async()=>{
 for(const path of ['/v1/images/edits','/images/edits']){
  const value=await fixture((url,init)=>{assert.equal(url,'https://api.openai.com/v1/images/edits');assert.equal(new Headers(init.headers).get('authorization'),'Bearer provider-key');const body=JSON.parse(init.body);assert.equal(body.model,'gpt-image-2');assert.equal(body.images[0].image_url,'https://example.com/image.png');assert.equal(body.mask.image_url,'https://example.com/mask.png');assert.equal(body.custom_field,'retained');return Response.json(output);});
  const response=await value.handler(new Request('https://gateway'+path,{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify({model:'image-alias',prompt:'Edit',images:[{image_url:'https://example.com/image.png'}],mask:{image_url:'https://example.com/mask.png'},custom_field:'retained'})}));
  assert.equal(response.status,200);assert.deepEqual(await response.json(),output);assert.equal(value.leases[0].p_model,'image-alias');assert.equal(value.finishes[0].p_input_tokens,12);assert.equal(value.finishes[0].p_output_tokens,7);assert.equal(value.finishes[0].p_cache_read_tokens,2);
 }
});
function form(){const data=new FormData();data.set('model','image-alias');data.set('prompt','Edit this image');data.append('image[]',new Blob([Uint8Array.of(0,1,255)],{type:'image/png'}),'input.png');data.append('image[]',new Blob(['second'],{type:'image/webp'}),'second.webp');data.set('mask',new Blob(['mask'],{type:'image/png'}),'mask.png');data.set('custom_field','retained');data.set('stream','false');return data;}
test('multipart image editing preserves binary uploads, filenames, repeated images and masks',async()=>{
 const value=await fixture(async(url,init)=>{
  assert.equal(url,'https://api.openai.com/v1/images/edits');assert.equal(new Headers(init.headers).get('content-type'),null);assert.ok(init.body instanceof FormData);
  assert.equal(init.body.get('model'),'gpt-image-2');assert.equal(init.body.get('custom_field'),'retained');
  const images=init.body.getAll('image[]');assert.equal(images.length,2);assert.equal(images[0].name,'input.png');assert.deepEqual(new Uint8Array(await images[0].arrayBuffer()),Uint8Array.of(0,1,255));assert.equal(await init.body.get('mask').text(),'mask');
  return Response.json(output);
 });
 const response=await value.handler(new Request('https://gateway/v1/images/edits',{method:'POST',headers:{authorization:'Bearer sk-client'},body:form()}));assert.equal(response.status,200);assert.equal(value.finishes[0].p_outcome,'completed');
});
test('multipart limits count actual wire bytes even when content-length understates the upload',async()=>{
 const request=new Request('https://gateway/v1/images/edits',{method:'POST',body:form()});const bytes=new Uint8Array(await request.arrayBuffer()),headers=new Headers(request.headers);headers.set('content-length','1');
 await assert.rejects(imageForm(new Request(request.url,{method:'POST',headers,body:bytes}),bytes.length-1),error=>error.status===413);
 const parsed=await imageForm(new Request(request.url,{method:'POST',headers,body:bytes}),bytes.length);assert.equal(parsed.body.model,'image-alias');assert.equal(parsed.body.stream,false);
});
test('image editing rejects missing inputs and duplicate model fields before reserving accounts',async()=>{
 const value=await fixture(()=>assert.fail('Must not dispatch'));
 for(const images of [undefined,[],[{file_id:'file-private'}]]){
  const response=await value.handler(new Request('https://gateway/v1/images/edits',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify({model:'image-alias',prompt:'Edit',images})}));assert.equal(response.status,400);
 }
 const duplicate=form();duplicate.append('model','different-model');const response=await value.handler(new Request('https://gateway/v1/images/edits',{method:'POST',headers:{authorization:'Bearer sk-client'},body:duplicate}));assert.equal(response.status,400);assert.equal(value.leases.length,0);
});
test('streaming image edits retain terminal events and token usage',async()=>{
 const value=await fixture((url,init)=>{
  assert.equal(JSON.parse(init.body).stream,true);
  return new Response('data: '+JSON.stringify({type:'image_generation.partial_image',b64_json:'cGFydA=='})+'\n\ndata: '+JSON.stringify({type:'image_generation.completed',b64_json:'aW1hZ2U=',usage:output.usage})+'\n\n',{headers:{'content-type':'text/event-stream'}});
 });
 const response=await value.handler(new Request('https://gateway/v1/images/edits',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify({model:'image-alias',prompt:'Edit',images:[{image_url:'https://example.com/image.png'}],stream:true})}));
 assert.equal(response.status,200);assert.match(await response.text(),/image_generation.completed/);assert.equal(value.finishes.length,1);assert.equal(value.finishes[0].p_outcome,'completed');assert.equal(value.finishes[0].p_input_tokens,12);assert.equal(value.finishes[0].p_output_tokens,7);
});
test('image editing uses the upstream default model when callers omit it',async()=>{
 const value=await fixture((url,init)=>{assert.equal(JSON.parse(init.body).model,'gpt-image-2');return Response.json(output);});
 const response=await value.handler(new Request('https://gateway/v1/images/edits',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify({prompt:'Edit',images:[{image_url:'https://example.com/image.png'}]})}));assert.equal(response.status,200);assert.equal(value.leases[0].p_model,'gpt-image-2');
});
test('OAuth images use the Codex native endpoint and forward only validated image fields',async()=>{
 for(const edit of [false,true]){
  const value=await fixture((url,init)=>{
   assert.equal(url,'https://chatgpt.com/backend-api/codex/images/'+(edit?'edits':'generations'));const headers=new Headers(init.headers);assert.equal(headers.get('authorization'),'Bearer oauth-private');assert.equal(headers.get('chatgpt-account-id'),'chatgpt-account');
   const body=JSON.parse(init.body);assert.equal(body.model,'gpt-image-2');assert.equal(body.prompt,'Draw');assert.equal(body.quality,'low');assert.equal(body.untrusted_field,undefined);if(edit)assert.equal(body.images[0].image_url,'https://example.com/image.png');return Response.json(output);
  },{type:'oauth'});
  const response=await value.handler(new Request('https://gateway/v1/images/'+(edit?'edits':'generations'),{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify({model:'gpt-image-2',prompt:'Draw',quality:'low',images:edit?[{image_url:'https://example.com/image.png'}]:undefined,untrusted_field:'removed'})}));assert.equal(response.status,200);assert.equal(value.finishes[0].p_outcome,'completed');assert.equal(value.finishes[0].p_output_tokens,7);
 }
});
test('OAuth multipart images and masks become lossless data URLs with numeric options',async()=>{
 const value=await fixture((url,init)=>{
  const body=JSON.parse(init.body);assert.equal(body.images[0].image_url,'data:image/png;base64,AAH/');assert.equal(body.images[1].image_url,'data:image/webp;base64,c2Vjb25k');assert.equal(body.mask.image_url,'data:image/png;base64,bWFzaw==');assert.equal(body.n,2);assert.equal(body.output_compression,0);assert.equal(body.custom_field,undefined);return Response.json(output);
 },{type:'oauth'});
 const data=form();data.set('n','2');data.set('output_compression','0');
 const response=await value.handler(new Request('https://gateway/v1/images/edits',{method:'POST',headers:{authorization:'Bearer sk-client'},body:data}));assert.equal(response.status,200);
});
test('OAuth url responses use MIME-aware data URLs and retain the client model alias',async()=>{
 for(const format of ['png','jpeg','webp']){
  const value=await fixture(()=>Response.json({...output,output_format:format}),{type:'oauth'});
  const response=await value.handler(new Request('https://gateway/v1/images/generations',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify({model:'image-alias',prompt:'Draw',response_format:'url'})}));
  assert.equal(response.status,200);const result=await response.json();assert.equal(result.data[0].url,`data:image/${format};base64,aW1hZ2U=`);assert.equal(result.data[0].b64_json,undefined);assert.equal(result.data[0].model,'image-alias');assert.equal(value.finishes[0].p_output_tokens,7);
 }
});
test('OAuth streaming edits normalize event names, retain base64 in url mode and complete usage',async()=>{
 const value=await fixture(()=>new Response('event: image_generation.completed\r\nid: event-1\r\ndata: '+JSON.stringify({type:'image_generation.completed',model:'upstream-internal',output_format:'webp',b64_json:'aW1hZ2U=',usage:output.usage})+'\r\n\r\n',{headers:{'content-type':'text/event-stream'}}),{type:'oauth'});
 const response=await value.handler(new Request('https://gateway/v1/images/edits',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify({model:'image-alias',prompt:'Edit',images:[{image_url:'https://example.com/image.png'}],stream:true,response_format:'url'})}));
 assert.equal(response.status,200);const text=await response.text();assert.match(text,/event: image_edit.completed/);assert.match(text,/id: event-1/);assert.doesNotMatch(text,/image_generation.completed|upstream-internal/);
 const result=JSON.parse(text.split('\n').find(line=>line.startsWith('data:')).slice(5));assert.equal(result.type,'image_edit.completed');assert.equal(result.url,'data:image/webp;base64,aW1hZ2U=');assert.equal(result.b64_json,'aW1hZ2U=');assert.equal(result.model,'image-alias');assert.equal(value.finishes[0].p_outcome,'completed');assert.equal(value.finishes[0].p_input_tokens,12);
});
test('URL-mode image streams accept duplicated representations larger than one raw image frame',async()=>{
 const image='A'.repeat(9*1024*1024);
 const value=await fixture(()=>new Response('data: '+JSON.stringify({type:'image_generation.completed',b64_json:image,usage:output.usage})+'\n\n',{headers:{'content-type':'text/event-stream'}}),{type:'oauth'});
 const response=await value.handler(new Request('https://gateway/v1/images/generations',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify({model:'gpt-image-2',prompt:'Draw',stream:true,response_format:'url'})}));
 let bytes=0;for await(const chunk of response.body)bytes+=chunk.length;
 assert.ok(bytes>18*1024*1024);assert.equal(value.finishes[0].p_outcome,'completed');assert.equal(value.finishes[0].p_output_tokens,7);
});

test('OAuth JSON image fallback emits edit completion and records aggregate usage once',async()=>{
 const value=await fixture(()=>Response.json({...output,data:[{b64_json:'Zmlyc3Q='},{b64_json:'c2Vjb25k'}]}),{type:'oauth'});
 const response=await value.handler(new Request('https://gateway/v1/images/edits',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify({model:'image-alias',prompt:'Edit',images:[{image_url:'https://example.com/image.png'}],stream:true,response_format:'url'})}));
 assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);
 const events=(await response.text()).split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5)));
 assert.equal(events.length,2);assert.ok(events.every(event=>event.type==='image_edit.completed'&&event.url==='data:image/png;base64,'+event.b64_json&&event.model==='image-alias'));
 assert.equal(events[0].usage,undefined);assert.equal(value.finishes.length,1);assert.equal(value.finishes[0].p_outcome,'completed');assert.equal(value.finishes[0].p_input_tokens,12);assert.equal(value.finishes[0].p_output_tokens,7);
});

test('Malformed edit image and mask references fail before account reservation',async()=>{
 const valid={image_url:'https://example.com/image.png'};
 const cases=[...['text',1,null,[],{}, {image_url:''},{file_id:'file-private'}].flatMap(image=>[{images:[image]},{images:[valid,image]}]),...['mask',1,null,[],{}, {image_url:' '},{file_id:'file-private'}].map(mask=>({images:[valid],mask}))];
 for(const fields of cases){
  const value=await fixture(()=>{throw Error('Invalid input reached provider');});
  const response=await value.handler(new Request('https://gateway/v1/images/edits',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify({prompt:'Edit',...fields})}));
  assert.equal(response.status,400,JSON.stringify(fields));assert.equal(value.leases.length,0);assert.equal(value.finishes.length,0);
 }
});

test('OAuth Responses bridge preserves image tool options, edits and aggregate usage',async()=>{
 for(const stream of [false,true]){
  const image={id:'img',type:'image_generation_call',result:'aW1hZ2U=',output_format:'webp',revised_prompt:'original'};
  const frames=[{type:'response.image_generation_call.partial_image',partial_image_index:0,partial_image_b64:'cGFydA=='},{type:'response.output_item.done',item:image},{type:'response.completed',response:{status:'completed',created_at:123,output:[image],usage:output.usage}}];
  const value=await fixture((url,init)=>{
   assert.equal(url,'https://chatgpt.com/backend-api/codex/responses');assert.equal(new Headers(init.headers).get('openai-beta'),'responses=experimental');
   const body=JSON.parse(init.body);assert.equal(body.model,'gpt-5.6-luna');assert.equal(body.stream,true);assert.equal(body.store,false);assert.equal(body.input[0].content[0].text,'Edit exactly');assert.equal(body.input[0].content[1].image_url,'https://example.com/image.png');assert.equal(body.tools[0].model,'gpt-image-1');assert.equal(body.tools[0].action,'edit');assert.equal(body.tools[0].input_image_mask.image_url,'https://example.com/mask.png');assert.equal(body.tools[0].output_format,'webp');assert.equal(body.tools[0].prompt,undefined);
   return new Response(frames.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
  },{type:'oauth',upstreamModel:'gpt-image-1'});
  const response=await value.handler(new Request('https://gateway/v1/images/edits',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify({model:'image-alias',prompt:'Edit exactly',images:[{image_url:'https://example.com/image.png'}],mask:{image_url:'https://example.com/mask.png'},output_format:'webp',stream,response_format:'url'})}));
  assert.equal(response.status,200);
  if(stream){const text=await response.text();assert.match(text,/event: image_edit.partial_image/);assert.match(text,/event: image_edit.completed/);assert.equal((text.match(/image_edit.completed/g)||[]).length,2);assert.match(text,/data:image\/webp;base64,aW1hZ2U=/);}
  else{const result=await response.json();assert.equal(result.created,123);assert.equal(result.data[0].url,'data:image/webp;base64,aW1hZ2U=');assert.equal(result.data[0].model,'image-alias');assert.equal(result.data[0].b64_json,undefined);}
  assert.equal(value.finishes.length,1);assert.equal(value.finishes[0].p_outcome,'completed');assert.equal(value.finishes[0].p_input_tokens,12);assert.equal(value.finishes[0].p_output_tokens,7);
 }
});

test('Responses image bridge requires successful terminal completion and never bills partial output',async()=>{
 const image={id:'img',type:'image_generation_call',result:'aW1hZ2U='};
 for(const terminal of [undefined,{type:'response.failed',response:{status:'failed'}},{type:'response.incomplete',response:{status:'incomplete'}},{type:'response.completed',response:{status:'completed',output:[]}}]){
  const events=[{type:'response.image_generation_call.partial_image',partial_image_b64:'cGFydA=='}];
  if(terminal?.type!=='response.completed')events.push({type:'response.output_item.done',item:image});
  if(terminal)events.push(terminal);
  const value=await fixture(()=>new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}}),{type:'oauth',upstreamModel:'gpt-image-1'});
  const response=await value.handler(new Request('https://gateway/v1/images/generations',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify({model:'gpt-image-1',prompt:'Draw'})}));
  assert.equal(response.status,502);assert.equal(value.finishes.length,1);assert.equal(value.finishes[0].p_outcome,'failed');
 }
});
test('Responses image bridge backfills terminal images from output-item events without duplicate usage',async()=>{
 const image={id:'img',type:'image_generation_call',result:'aW1hZ2U='};
 const value=await fixture(()=>new Response([{type:'response.output_item.done',item:image},{type:'response.output_item.done',item:image},{type:'response.completed',response:{status:'completed',output:[],usage:output.usage}}].map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}}),{type:'oauth',upstreamModel:'gpt-image-1'});
 const response=await value.handler(new Request('https://gateway/v1/images/generations',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify({model:'gpt-image-1',prompt:'Draw'})}));
 assert.equal(response.status,200);assert.equal((await response.json()).data.length,1);assert.equal(value.finishes.length,1);assert.equal(value.finishes[0].p_output_tokens,7);
});

test('Responses image bridge handles image frames larger than the text-event limit',async()=>{
 const image='A'.repeat(2*1024*1024);
 const value=await fixture(()=>new Response('data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[{id:'img',type:'image_generation_call',result:image}],usage:output.usage}})+'\n\n',{headers:{'content-type':'text/event-stream'}}),{type:'oauth',upstreamModel:'gpt-image-1'});
 const response=await value.handler(new Request('https://gateway/v1/images/generations',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify({model:'gpt-image-1',prompt:'Draw'})}));
 assert.equal(response.status,200);assert.equal((await response.json()).data[0].b64_json.length,image.length);assert.equal(value.finishes[0].p_outcome,'completed');
});

test('Cancelling a Responses image stream cancels an upstream waiting for more events',async()=>{
 let cancelled=false;
 const response=await imageResponses(new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({type:'response.image_generation_call.partial_image',partial_image_b64:'cGFydA=='})+'\n\n'));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}}),true);
 const reader=response.body.getReader();assert.equal((await reader.read()).done,false);
 await reader.cancel();assert.equal(cancelled,true);
});
