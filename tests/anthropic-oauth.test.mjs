import assert from 'node:assert/strict';
import test from 'node:test';
import { proxy } from '../supabase/functions/sub2api/proxy.ts';
import { refreshAnthropicCredentials } from '../supabase/functions/sub2api/anthropic_oauth.ts';

async function fixture({expired=false,reject=false,stream=false,setupToken=false,protocol='messages'}={}) {
 let credentials={access_token:'old-provider-token',refresh_token:'private-refresh-token',expires_at:Date.now()+(expired?-1000:3600000),provider_metadata:{preserved:true}};
 if(setupToken)delete credentials.refresh_token;
 let version=1,dispatched=0,refreshes=0;
 const finished=[],saved=[];
 const db={config:{dataModel:'native',encryptionKey:''},async rpc(name,body){
  if(name==='s2a_personal_acquire')return {lease_id:crypto.randomUUID(),account:{id:'1',platform:'anthropic',type:'oauth',credential_storage:'vault',credentials,credential_version:version}};
  if(name==='s2a_gateway_account_snapshot')return {id:'1',credentials,credential_version:version};
  if(name==='s2a_gateway_refresh_acquire')return true;
  if(name==='s2a_gateway_refresh_save'){saved.push(body);credentials=body.p_credentials;version++;return true;}
  if(name==='s2a_gateway_refresh_release'||name==='s2a_personal_ops_error_record')return null;
  if(name==='s2a_personal_finish'){finished.push(body);return null;}
  assert.fail('Unexpected RPC: '+name);
 },async fetchImpl(url,init){
  if(url==='https://platform.claude.com/v1/oauth/token'){
   refreshes++;const body=JSON.parse(init.body);
   assert.equal(body.refresh_token,'private-refresh-token');assert.equal(body.grant_type,'refresh_token');
   assert.equal(init.redirect,'error');
   return Response.json({access_token:'new-provider-token',refresh_token:'rotated-provider-refresh',expires_in:3600});
  }
  assert.equal(url,'https://api.anthropic.com/v1/messages');
  const h=new Headers(init.headers);assert.equal(h.get('x-api-key'),null);
  assert.equal(h.get('authorization'),'Bearer '+credentials.access_token);
  assert.ok(h.get('anthropic-beta').split(',').includes('oauth-2025-04-20'));
  assert.equal(init.redirect,'error');dispatched++;
  if(reject&&dispatched===1)return new Response('private provider error',{status:401});
  if(stream)return new Response([
   {type:'message_start',message:{usage:{input_tokens:3,cache_read_input_tokens:4,output_tokens:0}}},
   {type:'content_block_delta',delta:{type:'text_delta',text:'hello'}},
   {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},
   {type:'message_stop'},
  ].map(x=>'data: '+JSON.stringify(x)+'\n\n').join(''),{headers:{'content-type':'text/event-stream','set-cookie':'private'}});
  return Response.json({type:'message',content:[{type:'text',text:'hello'}],stop_reason:'end_turn',usage:{input_tokens:3,cache_read_input_tokens:4,output_tokens:2}});
 }};
 const request=new Request('https://gateway.invalid/v1/'+protocol,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'claude-test',...(protocol==='responses'?{input:'hello',max_output_tokens:16}:{messages:[{role:'user',content:'hello'}],max_tokens:16}),stream})});
 const response=await proxy(request,'/v1/'+protocol,'existing-app-key',db,{requestId:crypto.randomUUID(),started:Date.now()});
 const text=await response.text();
 return {response,text,finished,saved,refreshes,dispatched};
}
for(const stream of [false,true])test(`native Anthropic OAuth forwards ${stream?'SSE':'JSON'} and records canonical cached-token usage`,async()=>{
 const result=await fixture({stream});assert.equal(result.response.status,200);assert.match(result.text,/hello/);
 assert.equal(result.response.headers.get('set-cookie'),null);
 assert.equal(result.finished.length,1);assert.equal(result.finished[0].p_input_tokens,7);assert.equal(result.finished[0].p_output_tokens,2);
 assert.equal(result.refreshes,0);
});
test('native Anthropic setup tokens work without a refresh token',async()=>{
 const result=await fixture({setupToken:true});assert.equal(result.response.status,200);assert.equal(result.refreshes,0);
});
for(const mode of ['expired','reject'])test(`native Anthropic OAuth refreshes ${mode} credentials through fenced Vault persistence`,async()=>{
 const result=await fixture({[mode]:true});assert.equal(result.response.status,200);assert.equal(result.refreshes,1);
 assert.equal(result.saved.length,1);assert.deepEqual(result.saved[0].p_credentials.provider_metadata,{preserved:true});
 assert.equal(result.saved[0].p_credentials.refresh_token,'rotated-provider-refresh');
 assert.equal(result.dispatched,mode==='reject'?2:1);
});
test('refresh failures never expose upstream tokens or malformed rotated credentials',async()=>{
 const credentials={access_token:'private',refresh_token:'private-refresh'};
 await assert.rejects(refreshAnthropicCredentials(credentials,async()=>new Response('private-refresh',{status:400})),error=>error.code==='anthropic_oauth_refresh_failed'||error.message==='anthropic_oauth_refresh_failed');
 await assert.rejects(refreshAnthropicCredentials(credentials,async()=>Response.json({access_token:'ok',expires_in:-1})),/invalid_oauth_refresh_response/);
});

for(const protocol of ['responses','chat/completions'])test(`native Anthropic OAuth bridges ${protocol} and preserves refresh retry`,async()=>{
 const result=await fixture({protocol,reject:true});assert.equal(result.response.status,200);
 const value=JSON.parse(result.text);assert.equal(protocol==='responses'?value.output.find(item=>item.type==='message').content[0].text:value.choices[0].message.content,'hello');
 assert.equal(result.refreshes,1);assert.equal(result.dispatched,2);assert.equal(result.finished[0].p_input_tokens,7);
});
