import test from 'node:test';
import assert from 'node:assert/strict';
import {proxy} from '../supabase/functions/sub2api/proxy.ts';
const png=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(900_000)]).toString('base64');
const markup=`![Generated image](data:image/png;base64,${png})`;
for(const platform of ['antigravity','gemini'])for(const stream of [false,true])test(`Gemini restores generated images from model history: ${platform} stream=${stream}`,async()=>{
 let calls=0;const finished=[];
 const contents=[{role:'user',parts:[{text:'Draw a circle'}]},{role:'model',parts:[{text:'Here is the original.\n'+markup+'\nDone.',thoughtSignature:'keep-signature'}]},{role:'user',parts:[{text:'Draw a rabbit'}]}];
 const db={config:{dataModel:'native'},async rpc(name,args){
  if(name==='s2a_personal_acquire')return {lease_id:'lease',allow_image_generation:true,account:{id:'1',platform,type:platform==='gemini'?'apikey':'oauth',credential_storage:'vault',credential_version:1,credentials:platform==='gemini'?{api_key:'private'}:{access_token:'private',project_id:'private-project',expires_at:Date.now()+3600000}}};
  if(name==='s2a_personal_finish'){finished.push(args);return null;}
  if(name==='s2a_personal_ops_error_record')return null;
  assert.fail(name);
 },async fetchImpl(url,init){
  calls++;const envelope=JSON.parse(init.body),body=envelope.request??envelope;
  if(body.contents.some(c=>c.parts.some(p=>p.text?.includes('data:image/'))))return Response.json({error:{message:'Input token count exceeds limit'}},{status:400});
  assert.deepEqual(body.contents[0],contents[0]);assert.deepEqual(body.contents[2],contents[2]);
  assert.equal(body.contents[1].parts[0].thoughtSignature,'keep-signature');assert.match(body.contents[1].parts[0].text,/Here is the original/);assert.match(body.contents[1].parts[0].text,/Done/);
  assert.deepEqual(body.contents[1].parts[1],{inlineData:{mimeType:'image/png',data:png}});
  const result={candidates:[{content:{role:'model',parts:[{text:'Model answer'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:20,candidatesTokenCount:2}};
  return platform==='gemini'&&!stream?Response.json(result):new Response('data: '+JSON.stringify(platform==='gemini'?result:{response:result})+'\n\n',{headers:{'content-type':'text/event-stream'}});
 }};
 const path='/v1beta/models/gemini-3-flash:'+(stream?'streamGenerateContent':'generateContent');
 const request=new Request('https://gateway.test'+path,{method:'POST',body:JSON.stringify({contents})});
 const response=await proxy(request,path,'key',db,{requestId:crypto.randomUUID(),started:Date.now()});assert.equal(response.status,200);assert.match(await response.text(),/Model answer/);assert.equal(calls,1);assert.equal(finished[0].p_input_tokens,20);
 assert.equal(contents[1].parts[0].text.includes(markup),true);
});

test('history restoration preserves user text, native parts, tool data, remote URLs and unrecognized Markdown',async()=>{
 const {normalizeGeminiImageHistory}=await import('../supabase/functions/sub2api/gemini_image_history.ts');
 const untouched=[{role:'user',parts:[{text:markup}]},{role:'model',parts:[{inlineData:{mimeType:'image/png',data:png}},{functionResponse:{name:'result',response:{text:markup}}},{text:'![image](data:image/png;base64,AAAA)'},{text:'![Generated image](https://example.com/private.png)'},{text:'![Generated image](data:image/png;base64,AAA)'},{text:markup,thought:true}]}];
 const body={contents:structuredClone(untouched)};normalizeGeminiImageHistory(body);assert.deepEqual(body.contents,untouched);
});
test('multiple generated images retain their original bytes and normalization is idempotent',async()=>{
 const {normalizeGeminiImageHistory}=await import('../supabase/functions/sub2api/gemini_image_history.ts');
 const body={contents:[{role:'model',parts:[{text:'Before '+markup+' between '+markup+' after'}]}]};
 normalizeGeminiImageHistory(body);const once=structuredClone(body);normalizeGeminiImageHistory(body);assert.deepEqual(body,once);
 assert.equal(body.contents[0].parts.filter(p=>p.inlineData?.data===png).length,2);assert.equal(body.contents[0].parts[0].text,'Before [Previously generated image] between [Previously generated image] after');
});
