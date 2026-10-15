import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackendHandler} from './handler.mjs';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
import {grokSearchInput,grokSearchOutput} from '../supabase/functions/sub2api/grok_search.ts';
const config={url:'https://database.invalid',serviceKey:'private',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
const output={object:'response',status:'completed',usage:{input_tokens:12,output_tokens:7},output:[{type:'web_search_call',action:{sources:[{url:'https://example.com/article#part',title:'123',snippet:'source summary'},{url:'https://other.example/'}]}},{type:'message',content:[{type:'output_text',text:'```json\n{"results":[{"url":"https://fabricated.example/","title":"invented"},{"url":"https://example.com/article","title":"Real title","snippet":"Real summary"}]}\n```'}]}]};
test('standalone Grok web and X searches share native authentication, routing and usage',async()=>{
 for(const type of ['apikey','oauth'])for(const kind of ['web_search','x_search'])for(const prefix of ['/v1','']){
  const credentials=await encryptCredentials(type==='apikey'?{api_key:'provider-private'}:{access_token:'oauth-private',expires_at:Date.now()+3600000},config.encryptionKey);
  const leases=[],finishes=[];let forwards=0;
  const handler=createBackendHandler(config,async(url,init)=>{
   if(String(url).endsWith('/s2a_personal_key_policy'))return Response.json({platform:'grok'});
   if(String(url).endsWith('/s2a_personal_acquire')){leases.push(JSON.parse(init.body));return Response.json({lease_id:'lease',upstream_model:'grok-4.6',account:{...credentials,id:'1',platform:'grok',type,credential_version:1}});}
   if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
   if(String(url).includes('/rpc/'))return Response.json(null);
   forwards++;assert.equal(url,type==='apikey'?'https://api.x.ai/v1/responses':'https://cli-chat-proxy.grok.com/v1/responses');assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+(type==='apikey'?'provider-private':'oauth-private'));
   const body=JSON.parse(init.body);assert.equal(body.model,'grok-4.6');assert.equal(body.stream,false);assert.equal(body.store,false);assert.equal(body.tools[0].type,kind);assert.match(body.input,/latest news/);assert.equal(body.tools[0].untrusted,undefined);
   if(kind==='x_search'){assert.deepEqual(body.tools[0].allowed_x_handles,['sample']);assert.equal(body.tools[0].enable_video_understanding,false);assert.equal(body.tools[0].from_date,'2026-10-01');assert.equal(body.tool_choice,'required');}
   return Response.json(output);
  });
  const response=await handler(new Request('https://gateway'+prefix+'/'+kind,{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify({query:' latest news ',max_results:2,allowed_x_handles:['sample'],from_date:' 2026-10-01 ',enable_video_understanding:false,untrusted:true})}));
  assert.equal(response.status,200);const result=await response.json();assert.equal(result.query,'latest news');assert.equal(result.provider,'grok-native');assert.equal(result.max_results,2);assert.deepEqual(result.results,[{url:'https://example.com/article#part',title:'Real title',snippet:'Real summary'},{url:'https://other.example/',title:'other.example',snippet:''}]);
  assert.equal(forwards,1);assert.equal(leases[0].p_billing_context.web_search,true);assert.equal(leases[0].p_billing_context.search_operation,kind);assert.equal(finishes.length,1);assert.equal(finishes[0].p_input_tokens,12);assert.equal(finishes[0].p_output_tokens,7);
 }
});
test('Grok search rejects malformed input before account acquisition and preserves input alias',async()=>{
 for(const fields of [{},{query:1},{query:'q',max_results:1.5},{query:'q',allowed_x_handles:[1]},{query:'q',enable_video_understanding:'false'}]){
  let acquired=false;const handler=createBackendHandler(config,async(url)=>{if(String(url).endsWith('/s2a_personal_acquire'))acquired=true;return Response.json(null);});
  const response=await handler(new Request('https://gateway/v1/x_search',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify(fields)}));assert.equal(response.status,400);assert.equal(acquired,false);
 }
 assert.equal(grokSearchInput({input:' query ',max_results:100},'web_search').maxResults,20);assert.equal(grokSearchInput({input:' query ',max_results:0},'web_search').query,'query');
});
test('Grok search source extraction ignores fabricated URLs, deduplicates citations and tolerates malformed optional fields',()=>{
 const search=grokSearchInput({query:'q',max_results:20},'web_search');
 assert.deepEqual(grokSearchOutput({output:{}},search).results,[]);
 const result=grokSearchOutput({output:[{type:'message',content:[{type:'output_text',text:'not json',annotations:[{type:'url_citation',url:'https://www.example.com/a#one'},{type:'web',url:'https://www.example.com/a#two'},{type:'web',url:'file:///private'},{type:'web',url:'javascript:alert(1)'}]}]}]},search);
 assert.equal(result.results.length,1);assert.equal(result.results[0].title,'example.com');
});

test('Grok search rejects other platforms and upstream failures without successful usage',async()=>{
 for(const [platform,status] of [['openai','completed'],['grok','failed'],['grok','incomplete']]){
  const stored=await encryptCredentials({api_key:'private'},config.encryptionKey);const finishes=[];let forwards=0;
  const handler=createBackendHandler(config,async(url,init)=>{
   if(String(url).endsWith('/s2a_personal_key_policy'))return Response.json({platform});
   if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',account:{...stored,id:'1',platform,type:'apikey',credential_version:1}});
   if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
   if(String(url).includes('/rpc/'))return Response.json(null);
   forwards++;return Response.json({...output,status});
  });
  const response=await handler(new Request('https://gateway/v1/web_search',{method:'POST',headers:{authorization:'Bearer sk-client','content-type':'application/json'},body:JSON.stringify({query:'q'})}));
  assert.equal(response.status,platform==='openai'?400:502);assert.equal(forwards,platform==='openai'?0:1);assert.equal(finishes.length,platform==='openai'?0:1);if(finishes.length)assert.equal(finishes[0].p_outcome,'failed');
 }
});
