import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {VERTEX_CLAUDE_ALIASES,VERTEX_ANTHROPIC_BETAS,vertexAnthropicModel,vertexAnthropicBody,vertexAnthropicRequest} from '../supabase/functions/sub2api/vertex_anthropic.ts';
import {createBackendHandler} from './handler.mjs';
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const credentials={service_account:{project_id:'project-1',client_email:'svc@project-1.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----\n'+Buffer.from(await crypto.subtle.exportKey('pkcs8',pair.privateKey)).toString('base64')+'\n-----END PRIVATE KEY-----'},location:'global'};
const signal=()=>AbortSignal.timeout(5000);
test('Vertex Anthropic model aliases and supported betas stay aligned with original Go',()=>{
 const aliases=readFileSync(new URL('../backend/internal/pkg/claude/constants.go',import.meta.url),'utf8').split('var ModelIDOverrides = map[string]string{')[1].split('}')[0];
 assert.deepEqual(VERTEX_CLAUDE_ALIASES,Object.fromEntries([...aliases.matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map(match=>[match[1],match[2]])));
 const betas=readFileSync(new URL('../backend/internal/service/gateway_upstream_request.go',import.meta.url),'utf8').split('var vertexSupportedBetaTokens = map[string]bool{')[1].split('}')[0];
 assert.deepEqual(VERTEX_ANTHROPIC_BETAS,[...betas.matchAll(/"([^"]+)":\s*true/g)].map(match=>match[1]));
 assert.equal(vertexAnthropicModel('claude-sonnet-4-5'),'claude-sonnet-4-5@20250929');assert.equal(vertexAnthropicModel('claude-sonnet-4-5-20250929'),'claude-sonnet-4-5@20250929');assert.equal(vertexAnthropicModel('claude-sonnet-4-5@20250929'),'claude-sonnet-4-5@20250929');assert.equal(vertexAnthropicModel('claude-sonnet-4-5',true),'claude-sonnet-4-5');
 for(const id of ['__proto__','constructor','toString'])assert.equal(vertexAnthropicModel(id),id);
});
test('Vertex Anthropic filters unsupported beta fields without mutating caller bodies',()=>{
 const body={model:'claude-sonnet-5-5',anthropic_version:'client-version',context_management:{edits:[]},thinking:{type:'adaptive',block_binding:'private'},fallbacks:['other'],fallback_credit_token:'private',messages:[{role:'user',content:'hello',output_config:{effort:'high'}}],tools:[{type:'computer_toolset_20260801'}],output_config:{effort:'high'}};
 const before=structuredClone(body),result=vertexAnthropicBody(body,'oauth-2025-04-20,context-management-2025-06-27, fine-grained-tool-streaming-2025-05-14,context-management-2025-06-27',body.model);
 assert.deepEqual(body,before);assert.equal(result.beta,'context-management-2025-06-27');assert.deepEqual(result.body.context_management,body.context_management);assert.equal(result.body.model,undefined);assert.equal(result.body.anthropic_version,'vertex-2023-10-16');assert.equal(result.body.thinking.block_binding,undefined);assert.equal(result.body.fallbacks,undefined);assert.equal(result.body.fallback_credit_token,undefined);assert.equal(result.body.messages[0].output_config,undefined);assert.deepEqual(result.body.output_config,body.output_config);
 assert.equal(vertexAnthropicBody(body,'unknown',body.model).body.context_management,undefined);
});
for(const {stream,mapped} of [{stream:false,mapped:false},{stream:true,mapped:false},{stream:false,mapped:true}])test('Vertex Anthropic gateway '+(mapped?'explicit mapping':stream?'stream':'JSON')+' uses scoped auth and native usage accounting',async()=>{
 let exchanges=0,provider=0;const finishes=[];
 const app=createBackendHandler({url:'https://db.invalid',serviceKey:'private',encryptionKey:'',adminIds:[],dataModel:'native'},async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',...(mapped?{upstream_model:'claude-sonnet-4-5',model_sources:{mapping:{public:'claude-sonnet-4-5'},include_upstream:true}}:{}),account:{id:'1',type:'service_account',platform:'anthropic',credential_version:1,credential_storage:'vault',credentials}});
  if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
  if(String(url).includes('/rpc/')){assert.ok(!String(url).includes('refresh'));return Response.json(null);}
  if(String(url)==='https://oauth2.googleapis.com/token'){exchanges++;return Response.json({access_token:'google-token',expires_in:3600});}
  provider++;assert.equal(url,'https://aiplatform.googleapis.com/v1/projects/project-1/locations/global/publishers/anthropic/models/'+(mapped?'claude-sonnet-4-5':'claude-sonnet-4-5@20250929')+':'+(stream?'streamRawPredict':'rawPredict'));
  const headers=new Headers(init.headers);assert.equal(headers.get('authorization'),'Bearer google-token');assert.equal(headers.has('x-api-key'),false);assert.equal(headers.has('anthropic-version'),false);assert.equal(headers.get('anthropic-beta'),'interleaved-thinking-2025-05-14');
  const outgoing=JSON.parse(init.body);assert.equal(outgoing.model,undefined);assert.equal(outgoing.anthropic_version,'vertex-2023-10-16');assert.equal(outgoing.max_tokens,16);assert.equal(init.redirect,'error');
  if(stream)return new Response([{type:'message_start',message:{usage:{input_tokens:3,cache_read_input_tokens:4,output_tokens:0}}},{type:'content_block_delta',delta:{type:'text_delta',text:'hello'}},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},{type:'message_stop'}].map(value=>'data: '+JSON.stringify(value)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
  return Response.json({type:'message',content:[{type:'text',text:'hello'}],stop_reason:'end_turn',usage:{input_tokens:3,cache_read_input_tokens:4,output_tokens:2}});
 });
 const response=await app(new Request('https://gateway/v1/messages',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json','anthropic-beta':'oauth-2025-04-20,interleaved-thinking-2025-05-14'},body:JSON.stringify({model:mapped?'public':'claude-sonnet-4-5',messages:[{role:'user',content:'hello'}],max_tokens:16,stream})}));
 assert.equal(response.status,200);assert.ok((await response.text()).includes('hello'));assert.equal(exchanges,1);assert.equal(provider,1);assert.equal(finishes.length,1);assert.equal(finishes[0].p_outcome,'completed');assert.equal(finishes[0].p_input_tokens,7);assert.equal(finishes[0].p_output_tokens,2);assert.equal(finishes[0].p_upstream_model,mapped?'claude-sonnet-4-5':'claude-sonnet-4-5@20250929');
});
test('Vertex Anthropic validation rejects unsupported auth and injected routing before token I/O',async()=>{
 const request=new Request('https://gateway/v1/messages');const noFetch=async()=>assert.fail('invalid configuration performed I/O');
 for(const [value,model] of [[{auth_mode:' apikey '},'claude-test'],[credentials,'../escape'],[{...credentials,location:'evil.example'},'claude-test'],[{...credentials,project_id:'project/path'},'claude-test']])await assert.rejects(vertexAnthropicRequest(value,{model},request,signal(),noFetch),error=>error.status===400);
});
