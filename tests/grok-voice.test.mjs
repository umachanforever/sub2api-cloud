import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackendHandler} from './handler.mjs';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
import {voiceUpload,voiceResponse} from '../supabase/functions/sub2api/grok_voice.ts';
const config={url:'https://database.invalid',serviceKey:'private',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
test('Grok voice preserves request JSON, multipart bytes and audio responses for API keys and OAuth',async()=>{
 for(const type of ['apikey','oauth'])for(const endpoint of ['tts','stt']){
  const stored=await encryptCredentials(type==='apikey'?{api_key:'provider-private'}:{access_token:'oauth-private',expires_at:Date.now()+3600000},config.encryptionKey),finishes=[];
  const wire=Uint8Array.of(0,255,1,13,10,128,3),audio=Uint8Array.of(82,73,70,70,0,255,7);
  const payload={text:'Hello',voice_id:'sample',model:'client-voice',custom_option:2};let calls=0;
  const handler=createBackendHandler(config,async(url,init)=>{
   if(String(url).endsWith('/s2a_personal_key_policy'))return Response.json({platform:'grok'});
   if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',model_sources:{mapping:{'*':'grok-text-only'},include_upstream:true},account:{...stored,id:'1',platform:'grok',type,credential_version:1}});
   if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
   if(String(url).includes('/rpc/'))return Response.json(null);
   calls++;assert.equal(url,'https://api.x.ai/v1/'+endpoint);const headers=new Headers(init.headers);assert.equal(headers.get('authorization'),'Bearer '+(type==='apikey'?'provider-private':'oauth-private'));assert.equal(headers.get('x-grok-client-version'),null);assert.equal(headers.get('x-xai-token-auth'),null);
   if(endpoint==='stt'){assert.deepEqual(new Uint8Array(init.body),wire);assert.equal(headers.get('content-type'),'multipart/form-data; boundary=original');}
   else assert.deepEqual(JSON.parse(init.body),payload);
   return endpoint==='tts'?new Response(audio,{headers:{'content-type':'audio/wav','content-disposition':'attachment; filename="speech.wav"'}}):Response.json({text:'transcript',duration:1.25});
  });
  const response=await handler(new Request('https://gateway/v1/'+endpoint,{method:'POST',headers:{authorization:'Bearer sk-client','content-type':endpoint==='tts'?'application/json':'multipart/form-data; boundary=original'},body:endpoint==='tts'?JSON.stringify(payload):wire}));
  assert.equal(response.status,200);assert.equal(calls,1);if(endpoint==='tts'){assert.equal(response.headers.get('content-type'),'audio/wav');assert.deepEqual(new Uint8Array(await response.arrayBuffer()),audio);}else assert.deepEqual(await response.json(),{text:'transcript',duration:1.25});
  assert.equal(finishes.length,1);assert.equal(finishes[0].p_outcome,'completed');assert.equal(finishes[0].p_input_tokens,null);assert.equal(finishes[0].p_upstream_model,endpoint);
 }
});
test('voice upload limits use actual bytes and reject empty bodies',async()=>{
 for(const length of [undefined,'1']){const headers=length?{'content-length':length}:{};await assert.rejects(()=>voiceUpload(new Request('https://gateway/stt',{method:'POST',headers,body:new Uint8Array(9)}),8),error=>error.status===413);}
 await assert.rejects(()=>voiceUpload(new Request('https://gateway/stt',{method:'POST',body:new Uint8Array()}),8),error=>error.status===400);
});
test('audio cancellation releases upstream and records cancellation instead of successful completion',async()=>{
 let cancelled=false;const outcomes=[];
 const upstream=new Response(new ReadableStream({start(controller){controller.enqueue(Uint8Array.of(1,2,3));},cancel(){cancelled=true;}}),{headers:{'content-type':'audio/mpeg'}});
 const response=voiceResponse(upstream,new AbortController().signal,async(status,usage)=>outcomes.push({...usage}));const reader=response.body.getReader();await reader.read();await reader.cancel();assert.equal(cancelled,true);assert.equal(outcomes.length,1);assert.equal(outcomes[0].outcome,'cancelled');
});
test('audio stream failures and empty responses never record successful completion',async()=>{
 for(const empty of [false,true]){
  const outcomes=[];
  const source=empty?new ReadableStream({start(controller){controller.close();}}):new ReadableStream({start(controller){controller.error(Error('provider disconnected'));}});
  const response=voiceResponse(new Response(source),new AbortController().signal,async(status,usage)=>outcomes.push({...usage}));
  if(empty)assert.equal((await response.arrayBuffer()).byteLength,0);else await assert.rejects(()=>response.arrayBuffer());assert.equal(outcomes.length,1);assert.equal(outcomes[0].outcome,'failed');
 }
});
test('non-Grok voice requests are rejected before account acquisition',async()=>{
 let acquisitions=0;const handler=createBackendHandler(config,async(url)=>{if(String(url).endsWith('/s2a_personal_key_policy'))return Response.json({platform:'openai'});if(String(url).endsWith('/s2a_personal_acquire'))acquisitions++;return Response.json(null);});
 const response=await handler(new Request('https://gateway/v1/tts',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify({text:'hello'})}));assert.equal(response.status,400);assert.equal(acquisitions,0);assert.equal((await response.json()).error.type,'grok_voice_requires_grok_group');
});

test('voice authentication rejects invalid and wrong-platform keys without reading the upload',async()=>{
 for(const [policy,status] of [[{error:'invalid_api_key',status:401},401],[{error:'ip_forbidden',status:403},403],[{platform:'openai'},400],[null,503]]){
  let reads=0,cancelled=false,acquisitions=0;
  const upload=new ReadableStream({pull(){reads++;throw Error('Rejected upload was read');},cancel(){cancelled=true;}},{highWaterMark:0});
  const handler=createBackendHandler(config,async(url)=>{if(String(url).endsWith('/s2a_personal_key_policy'))return Response.json(policy);if(String(url).endsWith('/s2a_personal_acquire'))acquisitions++;return Response.json(null);});
  const response=await handler(new Request('https://gateway/v1/stt',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'multipart/form-data; boundary=original'},body:upload,duplex:'half'}));
  assert.equal(response.status,status);assert.equal(reads,0);assert.equal(cancelled,true);assert.equal(acquisitions,0);
 }
});

test('custom voice lifecycle preserves methods, multipart uploads, audio and empty deletion responses',async()=>{
 for(const type of ['apikey','oauth'])for(const [path,method,status] of [['custom-voices','POST',201],['custom-voices','GET',200],['custom-voices/voice_1','GET',200],['custom-voices/voice_1','PATCH',200],['custom-voices/voice_1','DELETE',204],['custom-voices/voice_1/audio','GET',200],['custom-voices/audio','GET',200],['custom-voices/audio','PATCH',200],['custom-voices/audio','DELETE',204]]){
  const stored=await encryptCredentials(type==='apikey'?{api_key:'provider-private'}:{access_token:'oauth-private',expires_at:Date.now()+3600000},config.encryptionKey);
  const bytes=Uint8Array.of(0,255,1,13,10,128),finishes=[];let calls=0;
  const handler=createBackendHandler(config,async(url,init)=>{
   if(String(url).endsWith('/s2a_personal_key_policy'))return Response.json({platform:'grok'});
   if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',model_sources:{mapping:{'*':'grok-text-only'},include_upstream:true},account:{...stored,id:'1',platform:'grok',type,credential_version:1}});
   if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
   if(String(url).includes('/rpc/'))return Response.json(null);
   calls++;assert.equal(url,'https://api.x.ai/v1/'+path+'?limit=5');assert.equal(init.method,method);
   if(['POST','PATCH'].includes(method)){assert.deepEqual(new Uint8Array(init.body),bytes);assert.equal(new Headers(init.headers).get('content-type'),'multipart/form-data; boundary=original');}else assert.equal(init.body,undefined);
   return status===204?new Response(null,{status}):path.endsWith('/audio')&&path!=='custom-voices/audio'?new Response(bytes,{headers:{'content-type':'audio/wav'}}):Response.json({id:'voice_1'},{status});
  });
  const response=await handler(new Request('https://gateway/'+(type==='apikey'?'v1/':'')+path+'?limit=5',{method,headers:{authorization:'Bearer sk-client','content-type':'multipart/form-data; boundary=original'},...(['POST','PATCH'].includes(method)?{body:bytes}:{})}));
  assert.equal(response.status,status);await response.arrayBuffer();assert.equal(calls,1);assert.equal(finishes.length,1);assert.equal(finishes[0].p_outcome,'completed');assert.equal(finishes[0].p_upstream_model,'custom-voices');
 }
});
