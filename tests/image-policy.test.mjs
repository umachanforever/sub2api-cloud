import test from 'node:test';
import assert from 'node:assert/strict';
import {imageGenerationIntent} from '../supabase/functions/sub2api/image_policy.ts';
import {createBackendHandler} from './handler.mjs';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
const config={url:'https://db.invalid',serviceKey:'private',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};

test('image permission intent covers image endpoints, models and native tools without treating input images as generation',()=>{
 for(const path of ['/v1/images/generations','/images/edits'])assert.equal(imageGenerationIntent(path,'alias',{}),true);
 for(const model of ['gpt-image-2','GPT-IMAGE-1.5','grok-imagine','grok-imagine-edit','grok-imagine-image-quality'])assert.equal(imageGenerationIntent('/v1/responses',model,{}),true);
 for(const body of [{tools:[{type:'image_generation'}]},{tool_choice:'image_generation'},{tool_choice:{function:{name:'image_generation'}}},{tool_choice:{tool:{type:'image_generation'}}}])assert.equal(imageGenerationIntent('/v1/responses','gpt-6',body),true);
 for(const body of [{input:'Explain image generation'},{input:[{type:'input_image',image_url:'https://example.com/input.png'}]},{tools:[{type:'function',name:'read_image'}]},{tool_choice:'auto'}])assert.equal(imageGenerationIntent('/v1/responses','gpt-6',body),false);
 assert.equal(imageGenerationIntent('/v1/responses','grok-imagine-video',{}),false);
});

test('passive Codex image catalogs count for OpenAI but not Grok; explicit Grok selections still count',()=>{
 for(const body of [{tools:[{type:'namespace',name:'image_gen'}]},{input:[{type:'additional_tools',tools:[{type:'namespace',name:'image_gen'}]}]}]){
  assert.equal(imageGenerationIntent('/v1/responses','gpt-6',body),true);assert.equal(imageGenerationIntent('/v1/responses','gpt-6',body,'grok'),false);
 }
 for(const choice of [{type:'namespace',namespace:'image_gen'},{type:'function',namespace:'image_gen',name:'imagegen'},{function:{name:'image_gen__imagegen'}},{tool:{name:'image_gen.imagegen'}}])assert.equal(imageGenerationIntent('/v1/responses','gpt-6',{tool_choice:choice},'grok'),true);
});

async function fixture({mapped='gpt-image-2',allowed=false,policyAllowed=true}={}){
 const stored=await encryptCredentials({api_key:'provider-private'},config.encryptionKey),acquires=[],finishes=[];let upstream=0;
 const handler=createBackendHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_key_policy'))return Response.json({platform:'openai',allow_image_generation:policyAllowed});
  if(String(url).endsWith('/s2a_personal_acquire')){acquires.push(JSON.parse(init.body));return Response.json({lease_id:'lease',allow_image_generation:allowed,upstream_model:mapped,account:{...stored,id:'1',platform:'openai',type:'apikey',credential_version:1}});}
  if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
  if(String(url).includes('/rpc/'))return Response.json(null);
  upstream++;return Response.json({created:1,data:[{b64_json:'aW1hZ2U='}]});
 });return {handler,acquires,finishes,get upstream(){return upstream;}};
}
function req(path,body){return new Request('https://gateway'+path,{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify(body)});}

test('native admission receives computed image intent rather than caller-provided flags',async()=>{
 const f=await fixture({allowed:true});
 const response=await f.handler(req('/v1/images/generations',{model:'alias',prompt:'Tree',image_generation:false,grok_image_generation:false}));assert.equal(response.status,200);
 assert.equal(f.acquires[0].p_billing_context.image_generation,true);assert.equal(f.acquires[0].p_billing_context.grok_image_generation,true);
});

test('mapped image aliases cannot bypass disabled group permissions and release their lease',async()=>{
 const f=await fixture();
 const response=await f.handler(req('/v1/responses',{model:'alias',input:'Draw a tree',stream:false}));assert.equal(response.status,403);assert.equal((await response.json()).error.type,'image_generation_forbidden');assert.equal(f.upstream,0);assert.equal(f.finishes.length,1);assert.equal(f.finishes[0].p_outcome,'failed');
});

test('disabled async image policy rejects before queue preparation or storage',async()=>{
 const f=await fixture({policyAllowed:false});
 const response=await f.handler(req('/v1/images/generations/async',{model:'gpt-image-2',prompt:'Tree'}));assert.equal(response.status,403);assert.equal(f.acquires.length,0);assert.equal(f.upstream,0);
});
