import test from 'node:test';
import assert from 'node:assert/strict';
import { modernCodexModel, validateCodexReasoning } from '../supabase/functions/sub2api/codex_models.ts';
import { allowsModel } from '../supabase/functions/sub2api/model_policy.ts';
import { normalizeBody } from '../supabase/functions/sub2api/gateway.ts';

test('modern Codex policy recognizes official spellings without admitting lookalikes', () => {
  for (const id of ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna']) {
    const policy = { enabled: true, models: [id] };
    for (const model of [id, 'openai/' + id + '-max', id.toUpperCase().replaceAll('-', '_'), id + '-openai-compact']) {
      assert.equal(modernCodexModel(model)?.id, id);
      assert.equal(allowsModel(policy, model), true, model);
    }
    for (const model of [id + 'itude', id + '-preview', id + '-max-extra']) {
      assert.equal(modernCodexModel(model), undefined);
      assert.equal(allowsModel(policy, model), false, model);
    }
  }
});

test('GPT-6.1 rejects explicit disabled reasoning across all request protocols', () => {
  for (const effort of ['none', 'minimal', ' NONE ']) {
    for (const field of [{ reasoning: { effort } }, { reasoning_effort: effort }, { output_config: { effort } }]) {
      assert.throws(() => validateCodexReasoning({ model: 'gpt-6.1-sol', ...field }), /requires reasoning/);
    }
  }
  for (const body of [{ model: 'gpt-6.1-sol-none' }, { model: 'openai/GPT_6.1_SOL_MINIMAL' }, { model: 'gpt-6.1-sol', thinking: { type: 'disabled' } }]) {
    assert.throws(() => validateCodexReasoning(body), /requires reasoning/);
  }
  for (const effort of [undefined, 'low', 'medium', 'high', 'xhigh', 'max']) {
    const body = normalizeBody({ model: 'gpt-6.1-sol', input: 'hello', reasoning: { effort } });
    assert.equal(body.model, 'gpt-6.1-sol');
    assert.equal(body.reasoning.effort, effort);
  }
  assert.doesNotThrow(() => validateCodexReasoning({ model: 'gpt-6-sol', reasoning_effort: 'none' }));
});

test('cloud rejects disabled GPT-6.1 reasoning before provider dispatch and settles its lease', async () => {
  const { createHandler } = await import('./handler.mjs');
  const { encryptCredentials } = await import('../supabase/functions/sub2api/credential_store.ts');
  const actor = '11111111-1111-4111-8111-111111111111';
  const id = '22222222-2222-4222-8222-222222222222';
  const config = { url: 'https://db.example', serviceKey: 'service', encryptionKey: Buffer.alloc(32, 7).toString('base64'), adminIds: [actor] };
  const encrypted = await encryptCredentials({ access_token: 'secret' }, config.encryptionKey);
  let finished = 0;
  const handler = createHandler(config, async (url, init) => {
    if (String(url).endsWith('/auth/v1/user')) return Response.json({ id: actor });
    if (String(url).endsWith('/s2a_acquire')) return Response.json({ lease_id: id, account: { id, ...encrypted, type: 'oauth', platform: 'openai', credential_version: 1 } });
    if (String(url).endsWith('/s2a_finish')) { assert.equal(JSON.parse(init.body).p_status, 400); finished++; return Response.json(null); }
    assert.fail('Invalid reasoning must not contact provider');
  });
  for (const [path, body] of [
    ['/v1/responses', { input: 'hello', reasoning: { effort: 'none' } }],
    ['/v1/chat/completions', { messages: [{ role: 'user', content: 'hello' }], reasoning_effort: 'minimal' }],
    ['/v1/messages', { messages: [{ role: 'user', content: 'hello' }], max_tokens: 32, thinking: { type: 'disabled' } }],
  ]) {
    const response = await handler(new Request('https://gateway' + path, { method: 'POST', headers: { authorization: 'Bearer session', 'x-s2a-frontend': '1' }, body: JSON.stringify({ model: 'gpt-6.1-sol', ...body }) }));
    assert.equal(response.status, 400, path);
  }
  assert.equal(finished, 3);
});

test('GPT-6 Responses keeps mode and max while removing incompatible sampling', async () => {
  const {normalizeModernCodexResponses}=await import('../supabase/functions/sub2api/codex_models.ts');
  for(const model of ['gpt-6-sol','gpt-6-luna','gpt-6.1-sol']) {
    const input={model,reasoning:{mode:'pro',effort:'max'},temperature:0.5,top_p:0.9,logprobs:true,top_logprobs:2,include:['message.output_text.logprobs','reasoning.encrypted_content'],prompt_cache_options:{ttl:'30m'}};
    normalizeModernCodexResponses(input);
    assert.deepEqual(input.reasoning,{mode:'pro',effort:'max'});
    for(const field of ['temperature','top_p','logprobs','top_logprobs'])assert.equal(field in input,false);
    assert.deepEqual(input.include,['reasoning.encrypted_content']);
    assert.equal(input.prompt_cache_options.ttl,'30m');
  }
  const disabled={model:'gpt-6-sol',reasoning:{effort:'none'},temperature:0.5,include:['message.output_text.logprobs']};
  normalizeModernCodexResponses(disabled);assert.equal(disabled.temperature,0.5);
  assert.deepEqual(disabled.include,['message.output_text.logprobs']);
});

test('Messages bridge preserves distinct max effort and modern model aliases', async () => {
  const {messagesToResponses}=await import('../supabase/functions/sub2api/anthropic_protocol.ts');
  for(const model of ['gpt-6.1-sol','gpt-6-sol','gpt-6-luna','gpt-6-astra','gpt-5.6-sol']) {
    const body=messagesToResponses({model,max_tokens:32,messages:[{role:'user',content:'hello'}],output_config:{effort:'max'}});
    assert.equal(body.reasoning.effort,'max',model);
  }
  const aliased=messagesToResponses({model:'openai/GPT_6.1_SOL_MAX',max_tokens:32,messages:[{role:'user',content:'hello'}]});
  assert.equal(aliased.model,'gpt-6.1-sol');assert.equal(aliased.reasoning.effort,'max');
  const legacy=messagesToResponses({model:'gpt-5.4',max_tokens:32,messages:[{role:'user',content:'hello'}],output_config:{effort:'max'}});
  assert.equal(legacy.reasoning.effort,'xhigh');
});

test('API key Responses applies model compatibility without mutating the request', async () => {
  const {apiKeyRequest}=await import('../supabase/functions/sub2api/api_key_provider.ts');
  const body={model:'gpt-6.1-sol',input:'hello',reasoning:{mode:'pro',effort:'max'},temperature:0.5,top_logprobs:2,include:['message.output_text.logprobs','reasoning.encrypted_content']};
  const outgoing=apiKeyRequest('openai',{api_key:'secret'},'responses','/v1/responses',body,new Request('https://gateway/v1/responses'),new AbortController().signal);
  const forwarded=JSON.parse(outgoing.init.body);
  assert.deepEqual(forwarded.reasoning,body.reasoning);
  assert.equal('temperature' in forwarded,false);assert.equal('top_logprobs' in forwarded,false);
  assert.deepEqual(forwarded.include,['reasoning.encrypted_content']);assert.equal(body.temperature,0.5);
  assert.throws(()=>apiKeyRequest('openai',{api_key:'secret'},'responses','/v1/responses',{...body,reasoning:{effort:'none'}},new Request('https://gateway/v1/responses'),new AbortController().signal),{status:400});
});


test('unqualified GPT versions default to Sol and preserve explicit variants', () => {
  const body=normalizeBody({model:'gpt-6',input:'hello'});
  assert.equal(body.model,'gpt-6-sol');
  assert.equal(allowsModel({enabled:true,models:['gpt-6-sol']},'gpt-6'),true);
});

 test('future GPT version aliases follow Sol without changing historical or explicit models',()=>{
  for(const version of ['6','6.1','6.2','7','10.3','5.6']) {
    const id='gpt-'+version;
    assert.equal(normalizeBody({model:id,input:'hello'}).model,id+'-sol');
    assert.equal(allowsModel({enabled:true,models:[id+'-sol']},id),true);
  }
  for(const id of ['gpt-5.4','gpt-6-astra','gpt-6-luna','gpt-6.1-sol','gpt-7-preview'])assert.equal(normalizeBody({model:id,input:'hello'}).model,id);
  assert.throws(()=>validateCodexReasoning({model:'gpt-6.1',reasoning:{effort:'none'}}),/requires reasoning/);
  assert.equal(allowsModel({enabled:true,models:['gpt-6-astra']},'gpt-6'),false);
});

test('cloud resolves default aliases after account mappings for API-key dispatch', async()=>{
 const {createHandler}=await import('./handler.mjs');
 const {encryptCredentials}=await import('../supabase/functions/sub2api/credential_store.ts');
 const id='22222222-2222-4222-8222-222222222222';
 const config={url:'https://db.example',serviceKey:'service',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[]};
 const encrypted=await encryptCredentials({api_key:'secret'},config.encryptionKey);
 for(const [requested,mapping,expected] of [['gpt-6',undefined,'gpt-6-sol'],['gpt-6.1',undefined,'gpt-6.1-sol'],['gpt-7.2',undefined,'gpt-7.2-sol'],['gpt-6','gpt-6-astra','gpt-6-astra']]){
  let dispatched=false,finished=false;
  const handler=createHandler(config,async(url,init)=>{
   if(String(url).endsWith('/s2a_acquire')){const args=JSON.parse(init.body);assert.equal(args.p_model,requested);assert.ok(args.p_billing_context.model_candidates.includes(requested+'-sol'));return Response.json({lease_id:id,account:{id,...encrypted,type:'apikey',platform:'openai',credential_version:1},...(mapping?{upstream_model:mapping}:{})});}
   if(String(url).endsWith('/s2a_finish')){finished=true;return Response.json(null);}
   assert.equal(JSON.parse(init.body).model,expected);dispatched=true;
   return Response.json({choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}});
  });
  const r=await handler(new Request('https://gateway/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer sk-test'},body:JSON.stringify({model:requested,messages:[{role:'user',content:'Hi'}]})}));
  assert.equal(r.status,200);assert.equal(dispatched,true);assert.equal(finished,true);
 }
});

test('model catalogs advertise version aliases only for available Sol targets',async()=>{
 const {modelListFromManifest}=await import('../supabase/functions/sub2api/gateway.ts');
 const {data}=modelListFromManifest({models:[{slug:'gpt-6',display_name:'Old alias'},{slug:'gpt-6-sol',display_name:'Sol'},{slug:'gpt-6-astra'},{slug:'gpt-7.2-sol'},{slug:'gpt-5.4'}]});
 assert.equal(data.find(m=>m.id==='gpt-6').display_name,'Sol');
 assert.equal(data.filter(m=>m.id==='gpt-6').length,1);
 assert.ok(data.some(m=>m.id==='gpt-7.2'));
 assert.ok(!data.some(m=>m.id==='gpt-5.4-sol'));
});
