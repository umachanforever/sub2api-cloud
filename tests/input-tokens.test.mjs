import assert from 'node:assert/strict';
import test from 'node:test';
import {createBackendHandler} from './handler.mjs';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
import {estimateInputTokens} from '../supabase/functions/sub2api/input_tokens.ts';
const config={url:'https://project.supabase.co',serviceKey:'service',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
async function fixture(forward,{platform='openai',type='apikey'}={}){
  const stored=await encryptCredentials(type==='apikey'?{api_key:'provider-secret'}:{access_token:'provider-secret',refresh_token:'refresh',expires_at:Date.now()+3600000},config.encryptionKey);
  const leases=[],finishes=[];
  const handler=createBackendHandler(config,async(url,init)=>{
    if(String(url).endsWith('/s2a_personal_acquire')){leases.push(JSON.parse(init.body));return Response.json({lease_id:'lease',account:{...stored,id:'1',platform,type,credential_version:1}});}
    if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
    return forward(String(url),init);
  });
  const request=(path,body,headers={authorization:'Bearer gateway-key'})=>handler(new Request('https://gateway'+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)}));
  return {request,leases,finishes};
}
test('Responses input token preflight preserves account model mapping, authenticates upstream and records no generated tokens',async()=>{
  for(const path of ['/v1/responses/input_tokens','/responses/input_tokens','/backend-api/codex/responses/input_tokens','/functions/v1/sub2api/v1/responses/input_tokens']){
    const value=await fixture((url,init)=>{
      assert.equal(url,'https://api.openai.com/v1/responses/input_tokens');assert.equal(init.headers.authorization,'Bearer provider-secret');
      assert.deepEqual(JSON.parse(init.body),{model:'gpt-6.1-sol',input:'Hello world'});return Response.json({object:'response.input_tokens',input_tokens:42,private_field:'hidden'});
    });
    const response=await value.request(path,{model:'gpt-6.1',input:'Hello world',stream:false,max_output_tokens:100});
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{object:'response.input_tokens',input_tokens:42});
    assert.equal(value.leases[0].p_model,'gpt-6.1');assert.equal(value.leases[0].p_billing_context.count_only,true);
    assert.equal(value.finishes.length,1);assert.equal(value.finishes[0].p_input_tokens,null);assert.equal(value.finishes[0].p_output_tokens,null);
    assert.equal(value.finishes[0].p_outcome,'completed');assert.equal(value.finishes[0].p_cooldown_seconds,0);
  }
});
test('upstream unsupported preflight uses tiktoken for OAuth scope errors and missing API-key endpoints',async()=>{
  for(const [type,status,body] of [['apikey',404,'not found'],['oauth',403,'{"error":{"code":"missing_scope"}}'],['oauth',401,'{"error":{"message":"Missing scopes: api.responses.write"}}'],['oauth',403,'<!doctype html><html>blocked</html>']]){
    const value=await fixture(()=>new Response(body,{status}),{type});
    const response=await value.request('/v1/responses/input_tokens',{model:'gpt-6.1',input:'Hello world'});
    assert.equal(response.status,200);assert.equal((await response.json()).input_tokens,2);
    assert.equal(value.finishes[0].p_cooldown_seconds,0);assert.equal(value.finishes[0].p_input_tokens,null);
  }
});
test('preflight rejects unauthenticated and malformed requests before acquiring accounts',async()=>{
  const value=await fixture(()=>assert.fail('Unexpected provider request'));
  assert.equal((await value.request('/v1/responses/input_tokens',{model:'gpt-test'},{})).status,401);
  for(const body of [{input:'hello'},{model:'gpt-test',stream:true},{model:'gpt-test',tools:['invalid']},{model:'gpt-test',instructions:42}])assert.equal((await value.request('/v1/responses/input_tokens',body)).status,400);
  assert.equal(value.leases.length,0);
});
test('preflight validates count responses and hides permanent provider failures without local fallback',async()=>{
  for(const response of [Response.json({input_tokens:-1}),Response.json({input_tokens:0.5}),Response.json({input_tokens:'42'}),Response.json({output:[{text:'unwanted generation'}]})]){
    const value=await fixture(()=>response);
    assert.equal((await value.request('/v1/responses/input_tokens',{model:'gpt-test',input:'Hello world'})).status,502);
    assert.equal(value.finishes.length,1);assert.equal(value.finishes[0].p_outcome,'failed');
  }
  for(const status of [400,401,403,429,500]){
    const value=await fixture(()=>Response.json({error:{message:'provider-secret'}},{status}),{type:'oauth'});
    const response=await value.request('/v1/responses/input_tokens',{model:'gpt-test',input:'hello'});
    assert.equal(response.status,status===500?502:status);assert.ok(!(await response.text()).includes('provider-secret'));
  }
});
test('tiktoken estimator counts framing, tools and multilingual text without tokenizing image payloads',async()=>{
  assert.equal(await estimateInputTokens({model:'gpt-6.1',input:'Hello world'}),2);
  assert.equal(await estimateInputTokens({model:'gpt-6.1',input:''}),1);
  assert.equal(await estimateInputTokens({model:'gpt-6.1',input:[{role:'user',content:'Hello world'}]}),6);
  const body={model:'gpt-6.1',instructions:'Reply clearly',input:[{role:'user',content:[{type:'input_text',text:'你好世界'},{type:'input_image',image_url:'data:image/png;base64,AA=='}]}],tools:[{type:'function',name:'lookup',parameters:{type:'object'}}]};
  const small=await estimateInputTokens(body);assert.ok(small>6);
  body.input[0].content[1].image_url='data:image/png;base64,'+'A'.repeat(1024*1024);
  assert.equal(await estimateInputTokens(body),small);
  assert.equal(await estimateInputTokens({model:'gpt-3.5-turbo',input:'Hello world'}),2);
});
test('Messages count_tokens bridges OpenAI and Grok without generating or recording usage',async()=>{
  for(const platform of ['openai','grok'])for(const path of ['/v1/messages/count_tokens','/messages/count_tokens']){
    let calls=0;
    const value=await fixture((url,init)=>{
      calls++;assert.equal(url,'https://api.openai.com/v1/responses/input_tokens');
      const body=JSON.parse(init.body);assert.equal(body.max_tokens,undefined);assert.equal(body.stream,undefined);
      assert.ok(body.input.some(item=>item.content?.some(part=>part.text==='Hello world')));
      return Response.json({input_tokens:13});
    },{platform});
    const response=await value.request(path,{model:'gpt-6.1',messages:[{role:'user',content:'Hello world'}]},{'x-api-key':'gateway-key'});
    assert.equal(response.status,200);const body=await response.json();assert.ok(body.input_tokens>0);assert.equal(body.object,undefined);
    assert.equal(calls,platform==='grok'?0:1);assert.equal(value.leases[0].p_billing_context.count_only,true);
    assert.equal(value.finishes[0].p_input_tokens,null);
  }
});
test('Anthropic count_tokens uses native API-key and OAuth headers and filters generation fields',async()=>{
  for(const type of ['apikey','oauth']){
    const value=await fixture((url,init)=>{
      assert.equal(url,'https://api.anthropic.com/v1/messages/count_tokens');const headers=new Headers(init.headers);
      assert.equal(headers.get(type==='apikey'?'x-api-key':'authorization'),type==='apikey'?'provider-secret':'Bearer provider-secret');
      assert.equal(headers.get('anthropic-version'),'2023-06-01');
      const body=JSON.parse(init.body);assert.equal(body.max_tokens,undefined);assert.equal(body.stream,undefined);
      return Response.json({input_tokens:19,private_field:'hidden'});
    },{platform:'anthropic',type});
    const response=await value.request('/v1/messages/count_tokens',{model:'claude-sonnet-4-5',messages:[{role:'user',content:'hello'}],max_tokens:99,stream:false});
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{input_tokens:19});assert.equal(value.finishes[0].p_input_tokens,null);
  }
});
test('Messages preflight rejects missing credentials, malformed messages and generation streams',async()=>{
  const value=await fixture(()=>assert.fail('Provider must not be called'));
  for(const body of [{model:'gpt-6.1'},{model:'gpt-6.1',messages:[]},{model:'gpt-6.1',messages:[{role:'user',content:'hi'}],stream:true}])assert.equal((await value.request('/v1/messages/count_tokens',body)).status,400);
  assert.equal(value.leases.length,0);
  assert.equal((await value.request('/v1/messages/count_tokens',{model:'gpt-6.1',messages:[{role:'user',content:'hi'}]},{})).status,401);
});
test('provider-specific preflight routes reject mismatched accounts before contacting providers',async()=>{
  for(const platform of ['openai','grok','anthropic'])for(const path of ['/antigravity/v1/messages/count_tokens','/antigravity/v1/responses/input_tokens']){
    const value=await fixture(()=>assert.fail('Mismatched route must not dispatch upstream'),{platform});
    const response=await value.request(path,{model:'gpt-6.1',input:'hello',messages:[{role:'user',content:'hello'}]});
    assert.equal(response.status,400);assert.equal((await response.json()).error.type,'provider_route_mismatch');
    assert.equal(value.finishes.length,1);assert.equal(value.finishes[0].p_outcome,'failed');assert.equal(value.finishes[0].p_cooldown_seconds,0);
  }
});
