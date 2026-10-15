import assert from 'node:assert/strict';
import test from 'node:test';
import {createBackendHandler} from './handler.mjs';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
import {searchResponsesBody,searchFromResponses} from '../supabase/functions/sub2api/alpha_search.ts';
const config={url:'https://project.supabase.co',serviceKey:'service',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
async function fixture(forward,{platform='openai',type='apikey',pat=false}={}){
  const stored=await encryptCredentials(type==='apikey'?{api_key:'provider-secret'}:{access_token:pat?'at-private-token':'provider-secret',refresh_token:'refresh',expires_at:Date.now()+3600000},config.encryptionKey);
  const leases=[],finishes=[];
  const handler=createBackendHandler(config,async(url,init)=>{
    if(String(url).endsWith('/s2a_personal_acquire')){leases.push(JSON.parse(init.body));return Response.json({lease_id:'lease',account:{...stored,id:'1',platform,type,credential_version:1}});}
    if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
    return forward(String(url),init);
  });
  const request=(path,body,headers={authorization:'Bearer gateway-key'})=>handler(new Request('https://gateway'+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)}));
  return {request,leases,finishes};
}
const body={model:'gpt-6.1',id:'search-id',commands:{search_query:[{q:'OpenAI news'}]},settings:{search_context_size:'low'},store:false,prompt_cache_key:'private',prompt_cache_retention:'24h'};
test('standalone search aliases use minimal OAuth headers, mapped models and no generation fields',async()=>{
 for(const path of ['/v1/alpha/search','/alpha/search','/backend-api/codex/alpha/search']){
  const value=await fixture((url,init)=>{
   assert.equal(url,'https://chatgpt.com/backend-api/codex/alpha/search?test=value');const headers=new Headers(init.headers);
   assert.equal(headers.get('authorization'),'Bearer provider-secret');assert.equal(headers.get('openai-beta'),null);assert.equal(headers.get('session_id'),null);assert.equal(headers.get('accept'),'application/json');
   const sent=JSON.parse(init.body);assert.equal(sent.model,'gpt-6.1-sol');assert.deepEqual(sent.commands,body.commands);
   for(const field of ['store','prompt_cache_key','prompt_cache_retention'])assert.equal(sent[field],undefined);
   return Response.json({output:'Search results',results:[{url:'https://example.com'}]});
  },{type:'oauth'});
  const response=await value.request(path+'?test=value',body);assert.equal(response.status,200);assert.equal((await response.json()).output,'Search results');
  assert.equal(value.leases[0].p_billing_context.web_search,true);assert.equal(value.finishes[0].p_outcome,'completed');assert.equal(value.finishes[0].p_input_tokens,null);
 }
});
test('API-key search uses the platform endpoint and sanitizes provider failures',async()=>{
 const value=await fixture((url,init)=>{assert.equal(url,'https://api.openai.com/v1/alpha/search');assert.equal(new Headers(init.headers).get('authorization'),'Bearer provider-secret');return new Response('provider-secret',{status:403});});
 const response=await value.request('/v1/alpha/search',body);assert.equal(response.status,403);assert.doesNotMatch(await response.text(),/provider-secret/);assert.equal(value.finishes[0].p_outcome,'failed');
});
test('PAT search falls back through hosted web search and requires a successful terminal event',async()=>{
 for(const complete of [false,true]){
  const value=await fixture((url,init)=>{
   assert.equal(url,'https://chatgpt.com/backend-api/codex/responses');assert.equal(new Headers(init.headers).get('authorization'),'Bearer at-private-token');
   const sent=JSON.parse(init.body);assert.equal(sent.tools[0].type,'web_search');assert.equal(sent.tools[0].search_context_size,'low');assert.match(sent.input[0].content[0].text,/OpenAI news/);assert.equal(sent.store,false);
   const events=[{type:'response.output_text.delta',delta:'News'}];if(complete)events.push({type:'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'News',annotations:[{type:'url_citation',url:'https://example.com',title:'Source'}]}]}]}});
   return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
  },{type:'oauth',pat:true});
  const response=await value.request('/v1/alpha/search',body);assert.equal(response.status,complete?200:502);
  if(complete)assert.deepEqual(await response.json(),{output:'News',results:[{type:'text_result',ref_id:'turn0search0',url:'https://example.com',title:'Source'}]});
  assert.equal(value.finishes[0].p_outcome,complete?'completed':'failed');
 }
});
test('search fallback restores completed text, deduplicates citations and rejects incomplete streams',async()=>{
 const response={status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Final text',annotations:[{type:'url_citation',url:'https://example.com'},{type:'url_citation',url:'https://example.com'}]}]}]};
 const result=await searchFromResponses(new Response('data: '+JSON.stringify({type:'response.completed',response})+'\n\n'));assert.equal(result.output,'Final text');assert.equal(result.results.length,1);
 for(const type of ['response.failed','response.incomplete','error'])await assert.rejects(()=>searchFromResponses(new Response('data: '+JSON.stringify({type})+'\n\n')),{status:502});
 const outgoing=searchResponsesBody({...body,input:'x'.repeat(20000)});assert.ok(outgoing.input[0].content[0].text.length<22000);
});
test('standalone search enforces model authentication and provider-specific routing',async()=>{
 const value=await fixture(()=>assert.fail('Must not contact provider'),{platform:'grok'});
 assert.equal((await value.request('/v1/alpha/search',body,{})).status,401);
 assert.equal((await value.request('/v1/alpha/search',{commands:{}})).status,400);
 assert.equal((await value.request('/v1/alpha/search',body)).status,501);
});
