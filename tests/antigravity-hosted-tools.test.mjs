import test from 'node:test';
import assert from 'node:assert/strict';
import {enableAntigravityTools,antigravityHostedResponse} from '../supabase/functions/sub2api/antigravity_tools.ts';
import {normalizeCodeAssist} from '../supabase/functions/sub2api/google_oauth.ts';
const source=values=>new Response(values.map(response=>'data: '+JSON.stringify({response})+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
const value=(parts,usage=1)=>({candidates:[{content:{role:'model',parts},finishReason:'STOP'}],usageMetadata:{promptTokenCount:usage,candidatesTokenCount:usage}});
const envelope=model=>({model,requestType:'agent',request:{contents:[{role:'user',parts:[{text:'Question'}]}],systemInstruction:{parts:[{text:'Original'}]}}});
const context=images=>({db:{rpc:()=>assert.fail('unexpected storage')},leaseId:'lease',images,signal:new AbortController().signal});
const call=name=>({functionCall:{name,args:name==='s2a_web_search'?{query:'news'}:{prompt:'Blue circle'}},thoughtSignature:'signature'});
const text=result=>result.candidates[0].content.parts.map(x=>x.text??'').join('');
const complete=async response=>await (await normalizeCodeAssist(response,false)).json();

test('Gemini and Claude retain the selected model and gain server tools in ordinary chat',()=>{
 for(const model of ['gemini-3-flash','claude-sonnet-4-6']){
  const body=envelope(model);body.request.toolConfig={functionCallingConfig:{mode:'NONE'}};
  const names=enableAntigravityTools(body,true);assert.deepEqual([...names],['s2a_web_search','s2a_generate_image']);assert.equal(body.model,model);assert.equal(body.request.toolConfig.functionCallingConfig.mode,'AUTO');assert.equal(body.request.tools[0].functionDeclarations.length,2);assert.match(body.request.systemInstruction.parts[0].text,/Original/);
 }
 const body=envelope('gemini-3-flash');enableAntigravityTools(body,false);assert.equal(body.request.tools[0].functionDeclarations.length,1);
});
test('native built-ins, caller functions and structured JSON keep their explicit tool contract',()=>{
 for(const extras of [{tools:[{googleSearch:{}}]},{tools:[{functionDeclarations:[{name:'s2a_web_search'}]}]},{generationConfig:{responseMimeType:'application/json'}}]){
  const body=envelope('gemini-3-flash');Object.assign(body.request,extras);const before=structuredClone(body);assert.equal(enableAntigravityTools(body,true).size,0);assert.deepEqual(body,before);
 }
});
test('image models request native images only with image permission',()=>{
 const body=envelope('gemini-3.1-flash-image');assert.throws(()=>enableAntigravityTools(body,false),/image_generation_forbidden/);assert.equal(enableAntigravityTools(body,true).size,0);assert.deepEqual(body.request.generationConfig.responseModalities,['TEXT','IMAGE']);
});
test('hosted search runs in the cloud and resumes the original model with sources and total usage',async()=>{
 const body=envelope('claude-sonnet-4-6'),names=enableAntigravityTools(body,true);let dispatched=0;
 const send=async request=>{
  dispatched++;
  if(dispatched===1){assert.equal(request.model,'gemini-3-flash');assert.deepEqual(request.request.tools,[{googleSearch:{}}]);const v=value([{text:'Verified fact'}],5);v.candidates[0].groundingMetadata={groundingChunks:[{web:{uri:'https://example.com/news',title:'Source'}}]};return source([v]);}
  assert.equal(request.model,'claude-sonnet-4-6');assert.equal(request.request.contents[1].parts[0].thoughtSignature,'signature');assert.equal(request.request.contents[1].parts.length,1);assert.match(request.request.contents[2].parts[0].functionResponse.response.sources,/example.com/);return source([value([{text:'Answer [source](https://example.com/news)'}],3)]);
 };
 const result=await complete(antigravityHostedResponse(source([value([{text:''},call('s2a_web_search'),{text:''}],10)]),body,names,send,context(true)));
 assert.equal(dispatched,2);assert.match(text(result),/Answer/);assert.ok(!JSON.stringify(result).includes('functionCall'));assert.equal(result.usageMetadata.promptTokenCount,18);assert.equal(result.usageMetadata.candidatesTokenCount,18);
});
function storageContext(){
 let uploads=0;
 const c={...context(true),db:{config:{url:'https://project.supabase.co',serviceKey:'private'},rpc:async(name,args)=>{assert.equal(name,'s2a_chat_media_register');assert.equal(args.p_lease_id,'lease');return true;},fetchImpl:async(url,init)=>{
  if(url.includes('/object/sign/'))return Response.json({signedURL:new URL(url).pathname.replace('/storage/v1','')+'?token=signed'});
  uploads++;assert.equal(init.body.length,5);return Response.json({});
 }}};
 return {c,uploads:()=>uploads};
}
test('image tool uploads bytes privately and returns HTTPS Markdown through the selected model',async()=>{
 const body=envelope('gemini-3-flash'),names=enableAntigravityTools(body,true),f=storageContext();let sent=0;
 const send=async request=>{
  if(++sent===1){assert.equal(request.model,'gemini-3.1-flash-image');assert.deepEqual(request.request.generationConfig.responseModalities,['TEXT','IMAGE']);return source([value([{inlineData:{mimeType:'image/png',data:'aGVsbG8='}}])]);}
  const markdown=request.request.contents[2].parts[0].functionResponse.response.image_markdown;assert.match(markdown,/https:/);return source([value([{text:markdown}])]);
 };
 const result=await complete(antigravityHostedResponse(source([value([call('s2a_generate_image')])]),body,names,send,f.c));assert.equal(f.uploads(),1);assert.match(text(result),/!\[Generated image\]\(https:/);assert.doesNotMatch(text(result),/base64|private/);assert.equal(text(result).match(/!\[Generated image\]/g).length,1);
});
test('generated images reach the client when the parent only acknowledges completion',async()=>{
 const body=envelope('gemini-3-flash'),names=enableAntigravityTools(body,true),f=storageContext();let sent=0;
 const send=async()=>++sent===1?source([value([{inlineData:{mimeType:'image/png',data:'aGVsbG8='}}])]):source([value([{text:'Image generated.'}])]);
 const result=await complete(antigravityHostedResponse(source([value([call('s2a_generate_image')])]),body,names,send,f.c));assert.match(text(result),/Image generated/);assert.match(text(result),/!\[Generated image\]\(https:/);assert.equal(f.uploads(),1);
});
test('direct Gemini image output is published instead of being dropped by chat conversion',async()=>{
 const body=envelope('gemini-3.1-flash-image'),names=enableAntigravityTools(body,true),f=storageContext();const result=await complete(antigravityHostedResponse(source([value([{inlineData:{mimeType:'image/png',data:'aGVsbG8='}}])]),body,names,()=>assert.fail('unexpected delegate'),f.c));assert.match(text(result),/https:/);assert.equal(f.uploads(),1);
});
test('ordinary text stays streaming and cancellation prevents subsequent tool dispatch',async()=>{
 const body=envelope('gemini-3-flash'),names=enableAntigravityTools(body,true);let cancelled=false;
 const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({response:{candidates:[{content:{parts:[{text:'First'}]}}]}})+'\n\n'));},cancel(){cancelled=true;}});
 const response=antigravityHostedResponse(new Response(stream,{headers:{'content-type':'text/event-stream'}}),body,names,()=>assert.fail('dispatch after cancel'),context(true));
 const reader=response.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/First/);await reader.cancel();assert.ok(cancelled);
});
test('failed delegated searches return safe errors and never leak upstream response bodies',async()=>{
 const body=envelope('gemini-3-flash'),names=enableAntigravityTools(body,false);const response=antigravityHostedResponse(source([value([call('s2a_web_search')])]),body,names,async()=>new Response('provider-private-token',{status:403}),context(false));await assert.rejects(new Response(response.body).text(),/web_search_failed/);
});

test('Chatbox requests execute Antigravity search without exposing client tool calls',async()=>{
 const {proxy}=await import('../supabase/functions/sub2api/proxy.ts');let sends=0;const finishes=[];
 const db={config:{dataModel:'native'},rpc:async(name,args)=>{
  if(name==='s2a_personal_acquire')return {lease_id:'lease',allow_image_generation:true,account:{id:'73',platform:'antigravity',type:'oauth',credential_storage:'vault',credential_version:1,credentials:{access_token:'private',project_id:'private-project',expires_at:Date.now()+3600000}}};
  if(name==='s2a_personal_finish'){finishes.push(args);return null;}
  if(name==='s2a_personal_ops_error_record')return null;
  assert.fail(name);
 },fetchImpl:async(url,init)=>{
  const body=JSON.parse(init.body);sends++;
  if(sends===1){assert.notEqual(body.request.toolConfig?.functionCallingConfig?.mode,'NONE');assert.equal(body.model,'gemini-3-flash');assert.ok(body.request.tools[0].functionDeclarations.some(x=>x.name==='s2a_generate_image'));return source([value([call('s2a_web_search')])]);}
  if(sends===2){const v=value([{text:'News'}]);v.candidates[0].groundingMetadata={groundingChunks:[{web:{uri:'https://example.com/news',title:'News'}}]};return source([v]);}
  assert.equal(body.model,'gemini-3-flash');return source([value([{text:'News [source](https://example.com/news)'}])]);
 }};
 const request=new Request('https://edge/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'gemini-3-flash',tools:[],tool_choice:'none',stream:false,messages:[{role:'user',content:'Search the news'}]})});
 const response=await proxy(request,'/v1/chat/completions','key',db,{requestId:crypto.randomUUID(),started:Date.now()});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.match(result.choices[0].message.content,/example.com/);assert.equal(result.choices[0].message.tool_calls,undefined);assert.equal(sends,3);assert.equal(finishes.length,1);assert.equal(finishes[0].p_input_tokens,3);
});

test('delegated searches reject unsafe source URLs and never invent successful results',async()=>{
 const body=envelope('gemini-3-flash'),names=enableAntigravityTools(body,false);
 const response=antigravityHostedResponse(source([value([call('s2a_web_search')])]),body,names,async()=>{const v=value([{text:'Unverified'}]);v.candidates[0].groundingMetadata={groundingChunks:[{web:{uri:'javascript:alert(1)',title:'Unsafe'}}]};return source([v]);},context(false));await assert.rejects(new Response(response.body).text(),/web_search_no_sources/);
});

test('hosted tool loops stop at a bounded number of upstream requests',async()=>{
 const body=envelope('gemini-3-flash'),names=enableAntigravityTools(body,false);let sends=0;
 const response=antigravityHostedResponse(source([value([call('s2a_web_search')])]),body,names,async request=>{sends++;if(request.requestType!=='web_search')return source([value([call('s2a_web_search')])]);const v=value([{text:'Fact'}]);v.candidates[0].groundingMetadata={groundingChunks:[{web:{uri:'https://example.com',title:'Source'}}]};return source([v]);},context(false));await assert.rejects(new Response(response.body).text(),/hosted_tool_limit/);assert.equal(sends,4);
});
