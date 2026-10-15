import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackendHandler} from './handler.mjs';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
import {imageForm} from '../supabase/functions/sub2api/image_input.ts';
const config={url:'https://database.invalid',serviceKey:'private',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
async function fixture(forward){
 const stored=await encryptCredentials({api_key:'provider-key'},config.encryptionKey),leases=[],finishes=[];
 const handler=createBackendHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_acquire')){leases.push(JSON.parse(init.body));return Response.json({lease_id:'lease',upstream_model:'gpt-image-2',account:{...stored,id:'1',platform:'openai',type:'apikey',credential_version:1}});}
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
