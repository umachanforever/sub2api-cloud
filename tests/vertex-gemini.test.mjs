import test from 'node:test';
import assert from 'node:assert/strict';
import {vertexGeminiRequest} from '../supabase/functions/sub2api/vertex_gemini.ts';
import {createBackendHandler} from './handler.mjs';
const signal=()=>AbortSignal.timeout(5000),body={contents:[{parts:[{text:'hello'}]}]};
test('Vertex Gemini Express and project API keys use native actions and keep secrets in headers',async()=>{
 for(const action of ['generateContent','streamGenerateContent','countTokens'])for(const project of ['', 'project-1']){
  const request=await vertexGeminiRequest({auth_mode:'apikey',api_key:'private-key',project_id:project,location:'global'},'/v1beta/models/gemini-test:'+action,body,signal(),async()=>assert.fail('API key request exchanged a token'));
  assert.equal(request.url,'https://aiplatform.googleapis.com/v1'+(project?'/projects/project-1/locations/global':'')+'/publishers/google/models/gemini-test:'+action+(action==='streamGenerateContent'?'?alt=sse':''));
  assert.equal(new Headers(request.init.headers).get('x-goog-api-key'),'private-key');assert.equal(new Headers(request.init.headers).has('authorization'),false);assert.equal(request.streaming,action==='streamGenerateContent');assert.equal(request.init.redirect,'error');assert.deepEqual(JSON.parse(request.init.body),body);
 }
 const regional=await vertexGeminiRequest({auth_mode:'apikey',api_key:'key',project_id:'project-1',vertex_model_locations:{'gemini-test':'europe-west1'}},'/v1beta/models/gemini-test:generateContent',body,signal(),fetch);
 assert.match(regional.url,/^https:\/\/europe-west1-aiplatform.googleapis.com\/v1\/projects\/project-1\/locations\/europe-west1\//);
});
test('Vertex request rejects injected models, locations, projects and invalid credentials before I/O',async()=>{
 const noFetch=async()=>assert.fail('invalid configuration performed I/O');
 for(const path of ['/v1beta/models/%2e%2e:generateContent','/v1beta/models/gemini%2fescape:generateContent','/v1beta/models/gemini:delete','/v1beta/models/%zz:countTokens'])await assert.rejects(vertexGeminiRequest({auth_mode:'apikey',api_key:'key'},path,body,signal(),noFetch),error=>error.status===400);
 for(const override of [{project_id:'project/path'},{project_id:'project',location:'evil.example'},{api_key:'key\nheader'},{api_key:''}])await assert.rejects(vertexGeminiRequest({auth_mode:'apikey',api_key:'key',...override},'/v1beta/models/gemini:generateContent',body,signal(),noFetch),error=>error.status===400);
});
test('Vertex JSON service accounts sign Google tokens and use project-scoped Bearer auth',async()=>{
 const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const key={project_id:'service-project',client_email:'svc@service-project.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----\n'+Buffer.from(await crypto.subtle.exportKey('pkcs8',pair.privateKey)).toString('base64')+'\n-----END PRIVATE KEY-----',token_uri:'https://evil.example/token'};
 let exchanges=0;
 const outgoing=await vertexGeminiRequest({service_account:key,project_id:'override-project'},'/v1beta/models/gemini-json:generateContent',body,signal(),async(url,init)=>{
  exchanges++;assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(init.redirect,'error');const form=new URLSearchParams(init.body),[header,payload,signature]=form.get('assertion').split('.');
  assert.equal(JSON.parse(Buffer.from(payload,'base64url')).iss,key.client_email);
  assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5',pair.publicKey,Buffer.from(signature,'base64url'),new TextEncoder().encode(header+'.'+payload)),true);
  return Response.json({access_token:'private-google-token',expires_in:3600});
 });
 assert.equal(exchanges,1);assert.equal(outgoing.url,'https://us-central1-aiplatform.googleapis.com/v1/projects/override-project/locations/us-central1/publishers/google/models/gemini-json:generateContent');
 assert.equal(new Headers(outgoing.init.headers).get('authorization'),'Bearer private-google-token');assert.equal(new Headers(outgoing.init.headers).has('x-goog-api-key'),false);
});
for(const action of ['generateContent','streamGenerateContent','countTokens'])test('Vertex gateway native '+action+' forwards through the owning account and records usage',async()=>{
 const finishes=[];let provider=0;
 const app=createBackendHandler({url:'https://db.invalid',serviceKey:'private',encryptionKey:'',adminIds:[],dataModel:'native'},async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_key_policy'))return Response.json({platform:'gemini'});
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',upstream_model:'gemini-upstream',account:{id:'1',type:'service_account',platform:'gemini',credential_version:1,credential_storage:'vault',credentials:{auth_mode:'apikey',api_key:'provider-key'}}});
  if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
  if(String(url).includes('/rpc/')){assert.ok(!String(url).includes('refresh'));return Response.json(null);}
  provider++;assert.equal(url,'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-upstream:'+action+(action==='streamGenerateContent'?'?alt=sse':''));assert.equal(new Headers(init.headers).get('x-goog-api-key'),'provider-key');assert.deepEqual(JSON.parse(init.body),body);
  if(action==='countTokens')return Response.json({totalTokens:17});
  const result={candidates:[{content:{role:'model',parts:[{text:'hello'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:2,totalTokenCount:5}};
  return action==='streamGenerateContent'?new Response('data: '+JSON.stringify(result)+'\n\n',{headers:{'content-type':'text/event-stream'}}):Response.json(result);
 });
 const response=await app(new Request('https://gateway/v1beta/models/gemini-public:'+action,{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify(body)}));
 assert.equal(response.status,200);const output=await response.text();assert.ok(output.includes(action==='countTokens'?'17':'hello'));assert.equal(provider,1);assert.equal(finishes.length,1);assert.equal(finishes[0].p_outcome,'completed');assert.equal(finishes[0].p_input_tokens,action==='countTokens'?null:3);assert.equal(finishes[0].p_output_tokens,action==='countTokens'?null:2);
});
