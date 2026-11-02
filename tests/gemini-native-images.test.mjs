import test from 'node:test';
import assert from 'node:assert/strict';
import {proxy} from '../supabase/functions/sub2api/proxy.ts';
import {imageGenerationIntent} from '../supabase/functions/sub2api/image_policy.ts';

const data=Buffer.alloc(900_000,7).toString('base64');
const config={responseModalities:['TEXT','IMAGE'],imageConfig:{aspectRatio:'1:1'}};
const pathFor=stream=>`/v1beta/models/gemini-3.1-flash-image:${stream?'streamGenerateContent':'generateContent'}`;
function fixture({platform='antigravity',type='oauth',allowed=true,stream=false,model='gemini-3.1-flash-image'}={}){
 const finishes=[],acquires=[];let sends=0;
 const db={config:{dataModel:'native'},async rpc(name,args){
  if(name==='s2a_personal_acquire'){acquires.push(args);return {lease_id:'lease',allow_image_generation:allowed,upstream_model:model,account:{id:'1',platform,type,credential_storage:'vault',credential_version:1,credentials:type==='apikey'?{api_key:'private'}:{access_token:'private',project_id:'private-project',expires_at:Date.now()+3600000}}};}
  if(name==='s2a_personal_finish'){finishes.push(args);return null;}
  if(name==='s2a_personal_ops_error_record')return null;
  assert.fail(name);
 },async fetchImpl(url,init){
  sends++;
  const body=JSON.parse(init.body);
  assert.deepEqual(type==='apikey'?body.generationConfig:body.request.generationConfig,config);
  const value={candidates:[{content:{role:'model',parts:[{inlineData:{mimeType:'image/png',data}}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:2,candidatesTokenCount:3}};
  if(type==='apikey'&&!stream)return Response.json(value);
  return new Response('data: '+JSON.stringify(type==='apikey'?value:{response:value})+'\n\n',{headers:{'content-type':'text/event-stream'}});
 }};
 const path=pathFor(stream),request=new Request('https://gateway.test'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts:[{text:'Draw a circle'}]}],generationConfig:config})});
 return {run:()=>proxy(request,path,'key',db,{requestId:crypto.randomUUID(),started:Date.now()}),finishes,acquires,get sends(){return sends;}};
}
for(const [platform,type] of [['antigravity','oauth'],['gemini','oauth'],['gemini','apikey']])for(const stream of [false,true])test(`native Gemini image bytes survive ${platform}/${type} stream=${stream}`,async()=>{
 const f=fixture({platform,type,stream});const response=await f.run();assert.equal(response.status,200);
 const raw=await response.text();assert.ok(raw.includes(data),'must retain all image bytes');assert.equal(f.finishes.length,1);assert.equal(f.finishes[0].p_outcome,'completed');assert.equal(f.acquires[0].p_billing_context.image_generation,true);
});
test('Gemini native image output permission detects both REST spellings and enum forms',()=>{
 for(const generation of ['generationConfig','generation_config'])for(const modalities of ['responseModalities','response_modalities'])for(const image of ['IMAGE',' image ',2])assert.equal(imageGenerationIntent(pathFor(true),'alias',{[generation]:{[modalities]:['TEXT',image]}}),true);
 for(const model of ['models/GEMINI-3.1-FLASH-IMAGE','gemini-3-pro-image-preview','gemini-2.5-flash-image'])assert.equal(imageGenerationIntent(pathFor(false),model,{}),true);
 assert.equal(imageGenerationIntent(pathFor(false),'gemini-3-flash',{contents:[{parts:[{inlineData:{mimeType:'image/png',data:'input'}}]}]}),false);
});
test('mapped native Gemini image requests cannot bypass disabled image permission',async()=>{
 const f=fixture({allowed:false,model:'gemini-3.1-flash-image'});await assert.rejects(f.run(),{code:'image_generation_forbidden'});assert.equal(f.sends,0);assert.equal(f.finishes.length,1);
});
