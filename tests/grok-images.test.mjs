import test from 'node:test';
import assert from 'node:assert/strict';
import {grokImageBody,grokImageForm} from '../supabase/functions/sub2api/grok_images.ts';

test('Grok multipart edits convert files and masks to native image references',async()=>{
 const form=new FormData();form.append('image[]',new Blob(['image'],{type:'image/png'}),'a.png');form.append('mask',new Blob(['mask'],{type:'image/png'}),'mask.png');
 const body=await grokImageForm(form,{model:'grok-imagine',prompt:'Edit',n:'2'});
 const native=grokImageBody(body,true);
 assert.equal(native.image.image_url,'data:image/png;base64,aW1hZ2U=');assert.equal(native.mask.image_url,'data:image/png;base64,bWFzaw==');assert.equal(native.n,2);
 assert.equal(native.model,'grok-imagine-image-quality');
});

test('Grok geometry preserves explicit values and matches original size conversion',()=>{
 const input={model:'grok-imagine-image',size:'1152x1536',resolution:'2K',aspect_ratio:'16:9'};
 assert.deepEqual(grokImageBody(input,false),{model:'grok-imagine-image',resolution:'2k',aspect_ratio:'16:9'});
 assert.equal(input.size,'1152x1536');
 assert.equal(grokImageBody({size:'1152x1536'},false).aspect_ratio,'3:4');
 assert.equal(grokImageBody({size:'4k'},false).resolution,'2k');
});

test('Grok multipart rejects extra images and invalid upload types before dispatch',async()=>{
 const form=new FormData();for(let i=0;i<4;i++)form.append('image',new Blob(['x'],{type:'image/png'}),'x.png');
 await assert.rejects(grokImageForm(form,{}),/invalid_image_count/);
 const invalid=new FormData();invalid.append('image',new Blob(['x'],{type:'text/plain'}),'x.txt');
 await assert.rejects(grokImageForm(invalid,{}),/invalid_image_upload/);
});

test('Grok OAuth images preserve native responses rather than the OpenAI Codex bridge',async()=>{
 const {proxy}=await import('../supabase/functions/sub2api/proxy.ts');
 const calls=[],finished=[];
 const db={config:{dataModel:'native'},async rpc(name,body){
  if(name==='s2a_personal_acquire')return {lease_id:'lease',account:{id:'1',platform:'grok',type:'oauth',credential_storage:'vault',credential_version:1,credentials:{access_token:'private-access',expires_at:Date.now()+3600000}}};
  if(name==='s2a_personal_finish'){finished.push(body);return;}
  assert.fail(name);
 },async fetchImpl(url,init){calls.push(url);assert.equal(new Headers(init.headers).get('authorization'),'Bearer private-access');assert.equal(JSON.parse(init.body).model,'grok-imagine-image-quality');return Response.json({data:[{url:'https://images.example/result.png'}]});}};
 const request=new Request('https://gateway/v1/images/generations',{method:'POST',body:JSON.stringify({model:'grok-imagine',prompt:'A bird'})});
 const response=await proxy(request,'/v1/images/generations','gateway-key',db,{requestId:'test'});
 assert.equal(response.status,200);assert.equal((await response.json()).data[0].url,'https://images.example/result.png');
 assert.deepEqual(calls,['https://cli-chat-proxy.grok.com/v1/images/generations']);assert.equal(finished.length,1);
});
