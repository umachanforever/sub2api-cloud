import test from 'node:test';
import assert from 'node:assert/strict';
import {grokImageBody,grokImageForm} from '../supabase/functions/sub2api/grok_images.ts';

test('Grok multipart edits convert files and masks to native image references',async()=>{
 const form=new FormData();form.append('image[]',new Blob(['image'],{type:'image/png'}),'a.png');form.append('mask',new Blob(['mask'],{type:'image/png'}),'mask.png');
 const body=await grokImageForm(form,{model:'grok-imagine',prompt:'Edit',n:'2'});
 const native=grokImageBody(body,true);
 assert.equal(native.image.url,'data:image/png;base64,aW1hZ2U=');assert.equal(native.mask.url,'data:image/png;base64,bWFzaw==');assert.equal(native.n,2);assert.equal(native.image.type,'image_url');assert.equal(native.mask.type,'image_url');
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

test('Grok native image references match the original wire contract',()=>{
 const body=grokImageBody({model:'grok-imagine-image',image:'https://images.example/one.png',reference_images:[{image_url:{url:'https://images.example/two.png'}}],mask:{url:'https://images.example/mask.png'}},true);
 assert.deepEqual(body.image,{url:'https://images.example/one.png',type:'image_url'});
 assert.deepEqual(body.images,[{url:'https://images.example/one.png',type:'image_url'},{url:'https://images.example/two.png',type:'image_url'}]);
 assert.deepEqual(body.mask,{url:'https://images.example/mask.png',type:'image_url'});
 assert.equal(body.reference_images,undefined);
 assert.throws(()=>grokImageBody({image:{file_id:'private-file'}},true),/image_input_required/);
});

test('Grok multipart editing passes through parsing, OAuth routing and native serialization',async()=>{
 const {proxy}=await import('../supabase/functions/sub2api/proxy.ts');
 let dispatched=0;const finished=[];
 const db={config:{dataModel:'native'},async rpc(name,body){
  if(name==='s2a_personal_acquire')return {lease_id:'lease',account:{id:'1',platform:'grok',type:'oauth',credential_storage:'vault',credential_version:1,credentials:{access_token:'private-access',expires_at:Date.now()+3600000}}};
  if(name==='s2a_personal_finish'){finished.push(body);return;}
  assert.fail(name);
 },async fetchImpl(url,init){
  dispatched++;assert.equal(url,'https://cli-chat-proxy.grok.com/v1/images/edits');assert.equal(new Headers(init.headers).get('content-type'),'application/json');
  const body=JSON.parse(init.body);assert.deepEqual(body.image,{url:'data:image/png;base64,aW1hZ2U=',type:'image_url'});assert.deepEqual(body.mask,{url:'data:image/png;base64,bWFzaw==',type:'image_url'});assert.equal(body.n,2);assert.equal(body.resolution,'2k');assert.equal(body.aspect_ratio,'3:4');
  return Response.json({data:[{url:'https://images.example/result.png'}]});
 }};
 const form=new FormData();form.set('model','grok-imagine-image');form.set('prompt','Edit');form.set('n','2');form.set('size','1152x1536');form.set('image',new Blob(['image'],{type:'image/png'}),'image.png');form.set('mask',new Blob(['mask'],{type:'image/png'}),'mask.png');
 const response=await proxy(new Request('https://gateway/v1/images/edits',{method:'POST',body:form}),'/v1/images/edits','gateway-key',db,{requestId:'test'});
 assert.equal(response.status,200);await response.json();assert.equal(dispatched,1);assert.equal(finished.length,1);
});

test('Grok image aliases select the canonical account model before applying account mappings',async()=>{
 const {proxy}=await import('../supabase/functions/sub2api/proxy.ts');
 let acquired=0;
 const db={config:{dataModel:'native'},async rpc(name,body){
  if(name==='s2a_personal_acquire'){
   acquired++;assert.equal(body.p_model,'grok-imagine-image-quality');assert.equal(body.p_billing_context.policy_model,'grok-imagine');assert.ok(body.p_billing_context.model_candidates.includes('grok-imagine-image-quality'));
   return {lease_id:'lease',account:{id:'1',platform:'grok',type:'oauth',credential_storage:'vault',credential_version:1,credentials:{access_token:'private-access',expires_at:Date.now()+3600000}},upstream_model:'grok-imagine-image-mapped'};
  }
  if(name==='s2a_personal_finish')return;
  assert.fail(name);
 },async fetchImpl(url,init){assert.equal(JSON.parse(init.body).model,'grok-imagine-image-mapped');return Response.json({data:[{url:'https://images.example/result.png'}]});}};
 const response=await proxy(new Request('https://gateway/v1/images/generations',{method:'POST',body:JSON.stringify({model:'grok-imagine',prompt:'A bird'})}),'/v1/images/generations','gateway-key',db,{requestId:'test'});
 assert.equal(response.status,200);await response.json();assert.equal(acquired,1);
});

test('Native image defaults authenticate first and never send OpenAI defaults to Grok',async()=>{
 const {proxy}=await import('../supabase/functions/sub2api/proxy.ts');
 for(const policy of [{platform:'grok'},{error:'invalid_api_key',status:401},null]){
  let checked=0;
  const db={config:{dataModel:'native'},async rpc(name){assert.equal(name,'s2a_personal_key_policy');checked++;return policy;},fetchImpl(){assert.fail('Missing model reached provider');}};
  await assert.rejects(proxy(new Request('https://gateway/v1/images/generations',{method:'POST',body:JSON.stringify({prompt:'A bird'})}),'/v1/images/generations','gateway-key',db,{requestId:'test'}),{status:policy?.platform==='grok'?400:policy?.status??503});
  assert.equal(checked,1);
 }
});

test('OpenAI groups retain their default image model after native key policy checks',async()=>{
 const {proxy}=await import('../supabase/functions/sub2api/proxy.ts');
 const calls=[];
 const db={config:{dataModel:'native'},async rpc(name,body){
  calls.push(name);
  if(name==='s2a_personal_key_policy')return {platform:'openai'};
  assert.equal(name,'s2a_personal_acquire');assert.equal(body.p_model,'gpt-image-2');
  return {error:'model_not_allowed',status:403};
 }};
 await assert.rejects(proxy(new Request('https://gateway/v1/images/generations',{method:'POST',body:JSON.stringify({prompt:'A bird'})}),'/v1/images/generations','gateway-key',db,{requestId:'test'}),{status:403,code:'model_not_allowed'});
 assert.deepEqual(calls,['s2a_personal_key_policy','s2a_personal_acquire']);
});
