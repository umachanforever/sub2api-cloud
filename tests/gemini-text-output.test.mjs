import test from 'node:test';
import assert from 'node:assert/strict';
import {proxy} from '../supabase/functions/sub2api/proxy.ts';

async function run({platform='antigravity',stream=false,snake=false,model='gemini-3-flash',upstreamModel=model,status=200}={}){
 const generation=snake?'generation_config':'generationConfig',modalities=snake?'response_modalities':'responseModalities',image=snake?'image_config':'imageConfig';
 const contents=[{role:'user',parts:[{text:'请画一张猫的图片'}]}];
 const body={contents,[generation]:{[modalities]:['TEXT','IMAGE'],[image]:{aspectRatio:'1:1'},temperature:0.7}};
 const sent=[],finishes=[];
 const db={config:{dataModel:'native'},async rpc(name,args){
  if(name==='s2a_personal_acquire')return {lease_id:'lease',upstream_model:upstreamModel,allow_image_generation:true,account:{id:'1',platform,type:platform==='gemini'?'apikey':'oauth',credential_storage:'vault',credential_version:1,credentials:platform==='gemini'?{api_key:'private'}:{access_token:'private',project_id:'private-project',expires_at:Date.now()+3600000}}};
  if(name==='s2a_personal_finish'){finishes.push(args);return null;}
  if(name==='s2a_personal_ops_error_record')return null;
  assert.fail(name);
 },async fetchImpl(url,init){
  const envelope=JSON.parse(init.body),outgoing=platform==='gemini'?envelope:envelope.request;sent.push(outgoing);
  if(status!==200)return Response.json({error:{message:'private upstream error'}},{status});
  if(outgoing[generation]?.[modalities]?.includes('IMAGE'))return Response.json({error:{message:'Unsupported response modality'}},{status:400});
  const result={candidates:[{content:{role:'model',parts:[{text:'这是模型自行返回的回答。'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:9,candidatesTokenCount:7}};
  return platform==='gemini'&&!stream?Response.json(result):new Response('data: '+JSON.stringify(platform==='gemini'?result:{response:result})+'\n\n',{headers:{'content-type':'text/event-stream'}});
 }};
 const path=`/v1beta/models/${model}:${stream?'streamGenerateContent':'generateContent'}`;
 const request=new Request('https://gateway.test'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const response=await proxy(request,path,'key',db,{requestId:crypto.randomUUID(),started:Date.now()});
 return {response,raw:await response.text(),sent,finishes,contents,generation,modalities,image};
}
for(const platform of ['antigravity','gemini'])for(const stream of [false,true])for(const snake of [false,true])test(`Flash image options allow a real model answer: ${platform} stream=${stream} snake=${snake}`,async()=>{
 const f=await run({platform,stream,snake});assert.equal(f.response.status,200);assert.match(f.raw,/这是模型自行返回的回答/);assert.equal(f.sent.length,1);
 assert.deepEqual(f.sent[0].contents,f.contents);assert.deepEqual(f.sent[0][f.generation],{[f.modalities]:['TEXT'],temperature:0.7});
 assert.equal(f.finishes[0].p_input_tokens,9);assert.equal(f.finishes[0].p_output_tokens,7);
});
test('normalization follows the mapped model rather than a caller alias',async()=>{
 const f=await run({model:'alias',upstreamModel:'gemini-3-flash-preview'});assert.match(f.raw,/这是模型自行返回的回答/);
});
for(const status of [400,401,429])test(`real upstream ${status} errors remain errors`,async()=>{
 await assert.rejects(run({platform:'gemini',status}),{status,code:'upstream_rejected_request'});
});
for(const upstreamModel of ['gemini-3.1-flash-image','future-unknown-model'])test(`image options are preserved for ${upstreamModel}`,async()=>{
 await assert.rejects(run({model:'gemini-3-flash',upstreamModel}),{status:400,code:'upstream_rejected_request'});
});

test('text compatibility handles image-only numeric modalities without modifying the caller body',async()=>{
 const {normalizeGeminiTextOutput}=await import('../supabase/functions/sub2api/gemini_text_output.ts');
 const original={responseModalities:[2],imageConfig:{aspectRatio:'1:1'},temperature:0.5};
 const body={generationConfig:original};normalizeGeminiTextOutput('gemini-3-flash',body);
 assert.deepEqual(body.generationConfig,{responseModalities:['TEXT'],temperature:0.5});
 assert.deepEqual(original,{responseModalities:[2],imageConfig:{aspectRatio:'1:1'},temperature:0.5});
});
