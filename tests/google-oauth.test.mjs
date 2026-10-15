import assert from 'node:assert/strict';
import test from 'node:test';
import {proxy} from '../supabase/functions/subscription-api/proxy.ts';
import {normalizeCodeAssist,refreshGoogleCredentials} from '../supabase/functions/subscription-api/google_oauth.ts';
import {googleOAuthClients} from '../supabase/functions/subscription-api/google_oauth_config.ts';
import {oauthSecrets} from '../scripts/deploy.mjs';

const clients={cli:{clientId:'test-cli-id',clientSecret:'test-cli-secret'},aiStudio:{clientId:'test-studio-id',clientSecret:'test-studio-secret'}};
const events=[{candidates:[{index:0,content:{role:'model',parts:[{text:'你'}]}}]},
 {candidates:[{index:0,content:{parts:[{text:'好'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:7,candidatesTokenCount:2,cachedContentTokenCount:3}}];
function sse(values,wrap=false){
 const bytes=new TextEncoder().encode(values.map(value=>'data: '+JSON.stringify(wrap?{response:value,traceId:'private-trace'}:value)+'\r\n\r\n').join(''));
 let offset=0;
 return new Response(new ReadableStream({pull(controller){if(offset===bytes.length)controller.close();else controller.enqueue(bytes.slice(offset,++offset));}}),{headers:{'content-type':'text/event-stream','set-cookie':'private'}});
}
async function fixture({codeAssist=false,stream=false,expired=false,reject=false,catalog=false}={}){
 let credentials={access_token:'old-provider-token',refresh_token:'private-refresh',expires_at:Date.now()+(expired?-1000:3600000),oauth_type:codeAssist?'code_assist':'ai_studio',...(codeAssist?{project_id:'private-project'}:{}),provider_metadata:{preserved:true}};
 let version=1,dispatched=0,refreshes=0;
 const finished=[],saved=[];
 const db={config:{dataModel:'native',encryptionKey:'',googleOAuth:clients},async rpc(name,body){
  if(name==='s2a_personal_acquire')return {lease_id:crypto.randomUUID(),upstream_model:catalog?undefined:'gemini-test',account:{id:'1',type:'oauth',platform:'gemini',credential_storage:'vault',credentials,credential_version:version}};
  if(name==='s2a_gateway_account_snapshot')return {id:'1',credentials,credential_version:version};
  if(name==='s2a_gateway_refresh_acquire')return true;
  if(name==='s2a_gateway_refresh_save'){saved.push(body);credentials=body.p_credentials;version++;return true;}
  if(name==='s2a_gateway_refresh_release'||name==='s2a_personal_ops_error_record')return null;
  if(name==='s2a_personal_finish'){finished.push(body);return null;}
  assert.fail('Unexpected RPC '+name);
 },async fetchImpl(url,init){
  if(url==='https://oauth2.googleapis.com/token'){
   refreshes++;const form=new URLSearchParams(init.body);assert.equal(form.get('refresh_token'),'private-refresh');assert.equal(form.get('client_id'),codeAssist?'test-cli-id':'test-studio-id');
   assert.equal(form.get('client_secret'),codeAssist?'test-cli-secret':'test-studio-secret');assert.equal(init.redirect,'error');
   return Response.json({access_token:'new-provider-token',expires_in:3600});
  }
  dispatched++;const h=new Headers(init.headers);assert.equal(h.get('authorization'),'Bearer '+credentials.access_token);assert.equal(h.get('x-goog-api-key'),null);assert.equal(init.redirect,'error');
  if(reject&&dispatched===1)return new Response('private-provider-error',{status:401});
  if(catalog){assert.equal(new URL(url).pathname,'/v1beta/models');return Response.json({models:[{name:'models/gemini-test'}]});}
  const body=JSON.parse(init.body);
  if(codeAssist){assert.equal(url,'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');assert.equal(body.model,'gemini-test');assert.equal(body.project,'private-project');assert.deepEqual(body.request.contents,[{parts:[{text:'hello'}]}]);return sse(events,true);}
  assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:'+(stream?'streamGenerateContent?alt=sse':'generateContent'));
  return stream?sse(events):Response.json({candidates:[{content:{parts:[{text:'你好'}]},finishReason:'STOP'}],usageMetadata:events[1].usageMetadata});
 }};
 const path=catalog?'/v1/models':'/v1beta/models/alias:'+(stream?'streamGenerateContent':'generateContent');
 const request=new Request('https://gateway.invalid'+path,{method:catalog?'GET':'POST',headers:{'content-type':'application/json'},...(catalog?{}:{body:JSON.stringify({contents:[{parts:[{text:'hello'}]}]})})});
 const response=await proxy(request,path,'existing-app-key',db,{requestId:crypto.randomUUID(),started:Date.now()});
 const text=await response.text();return {response,text,finished,saved,refreshes,dispatched};
}
for(const codeAssist of [false,true])for(const stream of [false,true])test(`Google ${codeAssist?'Code Assist':'AI Studio'} OAuth ${stream?'SSE':'JSON'} preserves native content and raw usage`,async()=>{
 const result=await fixture({codeAssist,stream});assert.equal(result.response.status,200);assert.match(result.text,/你/);assert.match(result.text,/好/);assert.doesNotMatch(result.text,/private-project|private-trace|provider-token/);
 assert.equal(result.response.headers.get('set-cookie'),null);assert.equal(result.finished.length,1);assert.equal(result.finished[0].p_input_tokens,7);assert.equal(result.finished[0].p_output_tokens,2);assert.equal(result.finished[0].p_cache_read_tokens,3);
 if(!stream)assert.ok(JSON.parse(result.text).candidates[0].content.parts.length);
});
for(const codeAssist of [false,true])for(const condition of ['expired','reject'])test(`Google OAuth refresh uses the ${codeAssist?'CLI':'AI Studio'} client after ${condition} and saves the entire canonical document`,async()=>{
 const result=await fixture({codeAssist,[condition]:true});assert.equal(result.response.status,200);assert.equal(result.refreshes,1);assert.equal(result.saved.length,1);assert.deepEqual(result.saved[0].p_credentials.provider_metadata,{preserved:true});assert.equal(result.saved[0].p_credentials.refresh_token,'private-refresh');
});
for(const codeAssist of [false,true])test(`Google OAuth ${codeAssist?'pinned Code Assist':'AI Studio upstream'} models use the common catalog response`,async()=>{
 const result=await fixture({codeAssist,catalog:true});assert.equal(result.response.status,200);assert.ok(JSON.parse(result.text).data.length);assert.equal(result.dispatched,codeAssist?0:1);
});
test('Code Assist aggregation rejects missing termination and sanitizes upstream errors',async()=>{
 await assert.rejects(normalizeCodeAssist(sse([events[0]],true),false),/incomplete_upstream_response/);
 await assert.rejects(normalizeCodeAssist(sse([{error:{message:'private-secret'}}]),false),error=>error.message==='invalid_upstream_response');
 await assert.rejects(normalizeCodeAssist(sse([{candidates:[{index:0,finishReason:'STOP'},{index:1,content:{parts:[{text:'partial'}]}}]}],true),false),/incomplete_upstream_response/);
});
test('canceling a normalized Code Assist stream cancels its provider body',{timeout:1000},async()=>{
 let signalCanceled;
 const canceled=new Promise(resolve=>{signalCanceled=resolve;});
 const upstream=new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({response:events[0]})+'\n\n'));},cancel(){signalCanceled();}}),{headers:{'content-type':'text/event-stream'}});
 const response=await normalizeCodeAssist(upstream,true);const reader=response.body.getReader();await reader.read();await reader.cancel();await canceled;
});
test('Google clients are private paired configuration and refresh failures do not reveal provider responses',async()=>{
 assert.equal(googleOAuthClients({}),undefined);
 assert.throws(()=>googleOAuthClients({GEMINI_CLI_OAUTH_CLIENT_ID:'id'}),/together/);
 assert.throws(()=>googleOAuthClients({GEMINI_CLI_OAUTH_CLIENT_ID:'id',GEMINI_CLI_OAUTH_CLIENT_SECRET:'secret\nINJECTED=x'}),/together/);
 assert.equal(oauthSecrets({GEMINI_OAUTH_CLIENT_ID:'test-id',GEMINI_OAUTH_CLIENT_SECRET:'test-secret'}),'GEMINI_OAUTH_CLIENT_ID=test-id\nGEMINI_OAUTH_CLIENT_SECRET=test-secret\n');
 await assert.rejects(refreshGoogleCredentials({access_token:'private',refresh_token:'private-refresh'},async()=>new Response('private-provider-detail',{status:400}),clients),error=>error.message==='google_oauth_refresh_failed');
});
