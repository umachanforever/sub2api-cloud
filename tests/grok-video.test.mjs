import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackendHandler} from './handler.mjs';
import {videoInput,videoRoute,providerVideoId} from '../supabase/functions/sub2api/grok_video.ts';

async function fixture({type='apikey',platform='grok',forward,resolve,accountId='1',refresh=false}={}){
 const events=[],finishes=[];let stored;let credentials={access_token:'oauth-private',refresh_token:'refresh-private',expires_at:Date.now()+3600000};
 const snapshot=()=>({id:accountId,platform:'grok',type,credential_storage:'vault',credential_version:1,credentials:type==='apikey'?{api_key:'provider-private'}:credentials});
 const config={url:'https://database.invalid',serviceKey:'private',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
 const handler=createBackendHandler(config,async(url,init)=>{
  const name=String(url).split('/').at(-1);
  if(name==='s2a_gateway_account_snapshot')return Response.json(snapshot());
  if(name==='s2a_gateway_refresh_acquire')return Response.json(true);
  if(name==='s2a_gateway_refresh_save'){credentials=JSON.parse(init.body).p_credentials;return Response.json(true);}
  if(name==='s2a_gateway_refresh_release')return Response.json(true);
  if(url==='https://auth.x.ai/oauth2/token')return Response.json({access_token:'rotated-private',refresh_token:'refresh-private',expires_in:3600});
  if(name==='s2a_personal_ops_error_record')return Response.json(true);
  if(name==='s2a_personal_key_policy')return Response.json({platform});
  if(name==='s2a_personal_video_resolve')return Response.json(resolve??stored??{error:'video_task_not_found',status:404});
  if(name==='s2a_personal_acquire'){
   events.push({name,body:JSON.parse(init.body)});
   return Response.json({lease_id:crypto.randomUUID(),upstream_model:'grok-imagine-video',account:snapshot()});
  }
  if(name==='s2a_personal_video_create'){
   const body=JSON.parse(init.body);events.push({name:body.p_action,body});
   if(body.p_action==='prepare')stored={public_id:body.p_public_id,model:'grok-imagine-video',upstream_model:body.p_upstream_model,account_id:'1',operation:body.p_operation,state:'creating'};
   if(body.p_action==='bind'){stored.upstream_id=body.p_upstream_id;stored.state='submitted';}
   if(body.p_action==='reject')stored.state='rejected';
   return Response.json({[body.p_action==='bind'?'bound':body.p_action==='prepare'?'prepared':'rejected']:true});
  }
  if(name==='s2a_personal_finish'){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
  if(String(url).includes('/rpc/'))assert.fail(name);
  events.push({name:'fetch',url,init});
  if(refresh&&events.filter(e=>e.name==='fetch').length===1)return new Response('unauthorized',{status:401});
  return forward?forward(url,init):Response.json({request_id:'provider-task',status:'pending'});
 });
 const request=(path,body,headers={},signal)=>handler(new Request('https://gateway'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json',...headers},...(signal?{signal}:{}),...(body===undefined?{}:{body:JSON.stringify(body)})}));
 return {request,events,finishes,get stored(){return stored;}};
}

test('video creation is durable before dispatch and polling uses the owning account',async()=>{
 for(const type of ['apikey','oauth']){
  const value=await fixture({type});
  const created=await value.request('/v1/videos/generations',{model:'grok-imagine-video',prompt:'A bird',image:{image_url:'https://images.example/a.png'}});
  assert.equal(created.status,200);const body=await created.json();assert.match(body.request_id,/^video_[a-f0-9]{40}$/);assert.equal(body.request_id,body.id);assert.equal(body.status,'pending');assert.ok(!JSON.stringify(body).includes('provider-task'));
  assert.deepEqual(value.events.map(e=>e.name),['s2a_personal_acquire','prepare','fetch','bind']);
  const sent=value.events.find(e=>e.name==='fetch');assert.equal(sent.url,(type==='oauth'?'https://cli-chat-proxy.grok.com':'https://api.x.ai')+'/v1/videos/generations');
  assert.deepEqual(JSON.parse(sent.init.body).image,{url:'https://images.example/a.png'});
  const status=await value.request('/v1/videos/'+body.id);assert.equal(status.status,200);assert.equal((await status.json()).id,body.id);
  assert.equal(value.events.filter(e=>e.name==='s2a_personal_acquire').at(-1).body.p_billing_context.video_task,body.id);
  assert.ok(value.events.filter(e=>e.name==='fetch').at(-1).url.endsWith('/v1/videos/provider-task'));
  assert.equal(value.finishes.length,2);assert.ok(value.finishes.every(f=>f.p_input_tokens===null&&f.p_output_tokens===null));
 }
});

test('all video create aliases route generations, edits and extensions',async()=>{
 for(const path of ['/videos','/v1/videos','/videos/generations','/v1/videos/edits','/videos/extensions']){
  const value=await fixture();const response=await value.request(path,{model:'grok-imagine-video',prompt:'Bird',video:{url:'https://videos.example/source.mp4'}});
  assert.equal(response.status,200);await response.json();assert.ok(value.events.find(e=>e.name==='fetch').url.endsWith('/v1/videos/'+(path.endsWith('edits')?'edits':path.endsWith('extensions')?'extensions':'generations')));
 }
});

test('foreign, unknown and mismatched video tasks never reach a provider',async()=>{
 const id='video_'+'a'.repeat(40);
 const missing=await fixture();assert.equal((await missing.request('/v1/videos/'+id)).status,404);assert.equal(missing.events.length,0);
 const mismatch=await fixture({resolve:{state:'submitted',operation:'edits'}});assert.equal((await mismatch.request('/v1/videos/generations/'+id)).status,404);assert.equal(mismatch.events.length,0);
 const wrong=await fixture({platform:'openai'});assert.equal((await wrong.request('/v1/videos',{model:'grok-imagine-video',prompt:'Bird'})).status,400);assert.equal(wrong.events.length,0);
});

test('video failures sanitize upstream errors and do not retry ambiguous creation',async()=>{
 for(const status of [400,401,429,500]){
  const value=await fixture({forward:()=>new Response('provider-private',{status})});
  const response=await value.request('/v1/videos',{model:'grok-imagine-video',prompt:'Bird'});
  assert.equal(response.status,status>=500?502:status);assert.ok(!(await response.text()).includes('provider-private'));
  assert.equal(value.events.filter(e=>e.name==='fetch').length,1);assert.equal(value.stored.state,status<500?'rejected':'creating');assert.equal(value.finishes.length,1);
 }
 const network=await fixture({forward:()=>{throw Error('provider-private');}});const response=await network.request('/v1/videos',{model:'grok-imagine-video',prompt:'Bird'});assert.equal(response.status,502);const failed=await response.json();assert.equal(failed.request_id,network.stored.public_id);const lookup=await network.request('/v1/videos/'+failed.request_id);assert.equal((await lookup.json()).status,'creation_unknown');assert.equal(network.stored.state,'creating');assert.equal(network.events.filter(e=>e.name==='fetch').length,1);
});

test('malformed video success leaves its durable intent and releases the account',async()=>{
 const value=await fixture({forward:()=>Response.json({request_id:'../private'})});const response=await value.request('/v1/videos',{model:'grok-imagine-video',prompt:'Bird'});
 assert.equal(response.status,502);assert.equal(value.stored.state,'creating');assert.equal(value.finishes.length,1);assert.equal(value.finishes[0].p_outcome,'failed');
});

test('unsubmitted tasks report uncertainty without inventing provider completion',async()=>{
 for(const state of ['creating','rejected']){
  const value=await fixture({resolve:{state,model:'grok-imagine-video',operation:'generations'}});const response=await value.request('/v1/videos/video_'+'a'.repeat(40));
  assert.equal(response.status,200);assert.equal((await response.json()).status,state==='creating'?'creation_unknown':'failed');assert.equal(value.events.length,0);
 }
});

test('a resolved task cannot dispatch through a different account',async()=>{
 const value=await fixture({accountId:'2',resolve:{state:'submitted',model:'grok-imagine-video',upstream_model:'grok-imagine-video',account_id:'1',operation:'generations',upstream_id:'task'}});
 const response=await value.request('/v1/videos/video_'+'a'.repeat(40));assert.equal(response.status,503);assert.equal(value.events.some(e=>e.name==='fetch'),false);assert.equal(value.finishes.length,1);
});

test('video input and route validation reject malformed models and traversal',()=>{
 assert.equal(videoRoute('/v1/videos/generations/x/content','GET').content,true);
 assert.throws(()=>videoInput({model:'grok',prompt:'x',stream:true},'generations'),/invalid_video_model/);
 assert.throws(()=>videoInput({model:'grok',prompt:''},'generations'),/invalid_video_prompt/);
 assert.throws(()=>videoInput({model:'grok',prompt:'x'},'edits'),/video_input_required/);
 assert.throws(()=>providerVideoId({request_id:'../task'}),/invalid_video_upstream_response/);
 assert.equal(providerVideoId({data:{task_id:'task-1'}}),'task-1');
});

test('OAuth video authentication rejection refreshes once without duplicating task intents',async()=>{
 const value=await fixture({type:'oauth',refresh:true});
 const response=await value.request('/v1/videos',{model:'grok-imagine-video',prompt:'Bird'});assert.equal(response.status,200);await response.json();
 assert.equal(value.events.filter(e=>e.name==='prepare').length,1);assert.equal(value.events.filter(e=>e.name==='bind').length,1);
 const calls=value.events.filter(e=>e.name==='fetch');assert.equal(calls.length,2);assert.equal(new Headers(calls[1].init.headers).get('authorization'),'Bearer rotated-private');
 assert.equal(value.finishes.length,1);
});

const downloadBinding={state:'submitted',model:'grok-imagine-video',upstream_model:'grok-imagine-video',account_id:'1',operation:'generations',upstream_id:'provider-task'};
const publicId='video_'+'a'.repeat(40);
test('signed video downloads preserve ranges and never send account authorization to the CDN',async()=>{
 const value=await fixture({resolve:downloadBinding,forward:(url,init)=>{
  if(url.endsWith('/v1/videos/provider-task'))return Response.json({status:'done',video:{url:'https://vidgen.x.ai/video.mp4?signature=private'}});
  assert.equal(url,'https://vidgen.x.ai/video.mp4?signature=private');const headers=new Headers(init.headers);assert.equal(headers.get('authorization'),null);assert.equal(headers.get('x-xai-token-auth'),null);assert.equal(headers.get('range'),'bytes=0-3');assert.equal(init.redirect,'error');
  return new Response(new Uint8Array([0,1,2,3]),{status:206,headers:{'content-type':'video/mp4','content-range':'bytes 0-3/100','content-length':'4','accept-ranges':'bytes','set-cookie':'never-forward'}});
 }});
 const response=await value.request('/v1/videos/'+publicId+'/content',undefined,{range:'bytes=0-3'});
 assert.equal(response.status,206);assert.equal(value.finishes.length,0);assert.equal(response.headers.get('content-range'),'bytes 0-3/100');assert.equal(response.headers.get('set-cookie'),null);
 assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[0,1,2,3]);assert.equal(value.finishes.length,1);assert.equal(value.finishes[0].p_outcome,'completed');
});

test('protected video content uses the owning account and supports empty range rejection',async()=>{
 for(const status of [200,416]){
  const value=await fixture({type:'oauth',resolve:downloadBinding,forward:(url,init)=>{
   if(!url.endsWith('/content'))return Response.json({video:{url:'https://relay.example/v1/videos/provider-task/content'}});
   assert.equal(url,'https://cli-chat-proxy.grok.com/v1/videos/provider-task/content');assert.equal(new Headers(init.headers).get('authorization'),'Bearer oauth-private');
   return new Response(status===416?null:'video',{status,headers:{'content-type':'video/mp4','content-range':status===416?'bytes */4':'bytes 0-3/4'}});
  }});
  const response=await value.request('/videos/generations/'+publicId+'/content');assert.equal(response.status,status);assert.equal(await response.text(),status===416?'':'video');assert.equal(value.finishes.length,1);assert.equal(value.finishes[0].p_status,status);
 }
});

test('status video URLs expose the gateway content route instead of the provider signature',async()=>{
 const value=await fixture({resolve:downloadBinding,forward:()=>Response.json({status:'done',video:{url:'https://vidgen.x.ai/provider-task.mp4?signature=private'}})});
 const response=await value.request('/v1/videos/'+publicId);const body=await response.json();assert.equal(body.video.url,'https://gateway/v1/videos/'+publicId+'/content');assert.ok(!JSON.stringify(body).includes('signature'));
});

test('untrusted signed destinations and redirects fail without forwarding credentials',async()=>{
 for(const url of ['http://vidgen.x.ai/video','https://evil.example/video','https://vidgen.x.ai.evil.example/video','https://user:secret@vidgen.x.ai/video','https://vidgen.x.ai:8443/video','//vidgen.x.ai/video']){
  const value=await fixture({resolve:downloadBinding,forward:()=>Response.json({video:{url}})});
  const response=await value.request('/v1/videos/'+publicId+'/content');assert.equal(response.status,502,url);assert.equal(value.events.filter(e=>e.name==='fetch').length,1);assert.equal(value.finishes.length,1);
 }
 const redirect=await fixture({resolve:downloadBinding,forward:url=>url.endsWith('/provider-task')?Response.json({video:{url:'https://vidgen.x.ai/video'}}):new Response(null,{status:302,headers:{location:'https://evil.example'}})});
 assert.equal((await redirect.request('/v1/videos/'+publicId+'/content')).status,502);assert.equal(redirect.events.filter(e=>e.name==='fetch').length,2);
});

test('cancelled video downloads cancel upstream and release their account once',async()=>{
 let cancelled=false;
 const value=await fixture({resolve:downloadBinding,forward:url=>url.endsWith('/provider-task')?Response.json({video:{url:'https://vidgen.x.ai/video'}}):new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1]));},cancel(){cancelled=true;}}),{headers:{'content-type':'video/mp4'}})});
 const response=await value.request('/v1/videos/'+publicId+'/content');const reader=response.body.getReader();await reader.read();await reader.cancel();
 assert.equal(cancelled,true);assert.equal(value.finishes.length,1);assert.equal(value.finishes[0].p_outcome,'cancelled');
});

test('video content validates task state, ownership and range before any download',async()=>{
 const pending=await fixture({resolve:{...downloadBinding,state:'creating'}});assert.equal((await pending.request('/v1/videos/'+publicId+'/content')).status,409);assert.equal(pending.events.length,0);
 const invalid=await fixture({resolve:downloadBinding});assert.equal((await invalid.request('/v1/videos/'+publicId+'/content',undefined,{range:'invalid'})).status,400);assert.equal(invalid.events.length,0);
 const unknown=await fixture();assert.equal((await unknown.request('/v1/videos/'+publicId+'/content')).status,404);assert.equal(unknown.events.length,0);
});

test('failed content streams sanitize errors and finish the lease as failed',async()=>{
 let pulls=0;
 const value=await fixture({resolve:downloadBinding,forward:url=>url.endsWith('/provider-task')?Response.json({video:{url:'https://vidgen.x.ai/video'}}):new Response(new ReadableStream({pull(controller){if(!pulls++)controller.enqueue(new Uint8Array([1]));else controller.error(new Error('provider-private'));}}),{headers:{'content-type':'video/mp4'}})});
 const response=await value.request('/v1/videos/'+publicId+'/content');await assert.rejects(response.arrayBuffer(),error=>error.message==='video_download_failed');assert.equal(value.finishes.length,1);assert.equal(value.finishes[0].p_outcome,'failed');
});

test('protected content authentication can refresh without changing the bound account',async()=>{
 let downloads=0;
 const value=await fixture({type:'oauth',resolve:downloadBinding,forward:(url,init)=>{
  if(!url.endsWith('/content'))return Response.json({status:'done'});
  if(!downloads++)return new Response('unauthorized',{status:401});
  assert.equal(new Headers(init.headers).get('authorization'),'Bearer rotated-private');return new Response('video',{headers:{'content-type':'video/mp4'}});
 }});
 const response=await value.request('/v1/videos/'+publicId+'/content');assert.equal(response.status,200);assert.equal(await response.text(),'video');assert.equal(downloads,2);assert.equal(value.finishes.length,1);
});
