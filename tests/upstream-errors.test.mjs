import test from 'node:test';
import assert from 'node:assert/strict';
import { upstreamErrorCode } from '../supabase/functions/sub2api/upstream_errors.ts';
import { errorClassification } from '../supabase/functions/sub2api/ops_errors.ts';

test('provider model errors expose only fixed categories', async () => {
  for (const [error, expected] of [
    [{code:'model_not_found',message:'private account secret'}, 'upstream_model_not_found'],
    [{code:'unsupported_model'}, 'upstream_model_unsupported'],
    [{code:'model_access_denied'}, 'upstream_model_access_denied'],
    [{message:"The model 'gpt-6.1-sol' is not supported when using Codex with a ChatGPT account."}, 'upstream_model_access_denied'],
    [{message:'This model does not exist'}, 'upstream_model_not_found'],
    [{message:'This model is not supported'}, 'upstream_model_unsupported'],
    [{message:'API key secret rejected',code:'secret'}, 'upstream_rejected_request'],
  ]) {
    const code = await upstreamErrorCode(Response.json({error},{status:400}));
    assert.equal(code,expected);
    assert.equal(code.includes('secret'),false);
    if(code!== 'upstream_rejected_request')assert.equal(errorClassification(code,400).owner,'provider');
  }
});

test('untrusted oversized, malformed and stalled error bodies fall back safely', async () => {
  for(const body of ['not json', JSON.stringify({error:{code:'model_not_found',message:'x'.repeat(17000)}}), 'null', '{"error":null}']) {
    assert.equal(await upstreamErrorCode(new Response(body,{status:400})),'upstream_rejected_request');
  }
  assert.equal(await upstreamErrorCode(Response.json({error:{code:'model_not_found'}},{status:500})),'upstream_rejected_request');
  let cancelled=false;
  const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));},cancel(){cancelled=true;}});
  assert.equal(await upstreamErrorCode(new Response(stream,{status:400})),'upstream_rejected_request');
  assert.equal(cancelled,true);
});

test('gateway returns classified model rejection and persists it without provider text', async () => {
  const {createHandler}=await import('../supabase/functions/sub2api/app.ts');
  const {encryptCredentials}=await import('../supabase/functions/sub2api/credential_store.ts');
  const actor='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
  const config={url:'https://db.example',serviceKey:'service',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[actor]};
  const encrypted=await encryptCredentials({access_token:'secret'},config.encryptionKey);
  const events=[]; let finished=0;
  const handler=createHandler(config,async(url,init)=>{
    const path=new URL(url).pathname;
    if(path.endsWith('/auth/v1/user'))return Response.json({id:actor});
    if(path.endsWith('/s2a_acquire'))return Response.json({lease_id:id,account:{id,...encrypted,type:'oauth',platform:'openai',credential_version:1}});
    if(path.endsWith('/s2a_log_write'))return Response.json(true);
    if(path.endsWith('/s2a_finish')){finished++;return Response.json(null);}
    if(path.endsWith('/s2a_ops_error_record')){events.push(JSON.parse(init.body));return Response.json(null);}
    assert.equal(new URL(url).hostname,'chatgpt.com');
    return Response.json({error:{message:"The model 'gpt-6.1-sol' is not supported when using Codex with a ChatGPT account. private@account.example",code:'unsupported_model'}},{status:400});
  });
  const response=await handler(new Request('https://gateway/v1/responses',{method:'POST',headers:{authorization:'Bearer session','x-s2a-frontend':'1'},body:JSON.stringify({model:'gpt-6.1-sol',input:'hello'})}));
  assert.equal(response.status,400);
  const text=await response.text();assert.equal(JSON.parse(text).error.type,'upstream_model_access_denied');
  assert.equal(text.includes('private@'),false);assert.equal(JSON.stringify(events).includes('private@'),false);
  assert.ok(events.some(event=>event.p_event.code==='upstream_model_access_denied'));
  assert.equal(finished,1);
});

for (const exhausted of [true,false]) test(`upstream rate limit survives ${exhausted?'account exhaustion':'retry limit'}`,async()=>{
 const {createHandler}=await import('../supabase/functions/sub2api/app.ts');
 const {encryptCredentials}=await import('../supabase/functions/sub2api/credential_store.ts');
 const actor='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
 const config={url:'https://db.example',serviceKey:'service',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[actor]};
 const encrypted=await encryptCredentials({access_token:'secret'},config.encryptionKey);
 let acquisitions=0,finished=0;
 const handler=createHandler(config,async(url)=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/auth/v1/user'))return Response.json({id:actor});
  if(path.endsWith('/s2a_acquire')){
   acquisitions++;
   return Response.json(exhausted&&acquisitions>1?{error:'no_available_account',status:503}:{lease_id:id,account:{id,...encrypted,type:'oauth',platform:'openai',credential_version:1}});
  }
  if(path.endsWith('/s2a_finish')){finished++;return Response.json(null);}
  if(path.endsWith('/s2a_log_write')||path.endsWith('/s2a_ops_error_record'))return Response.json(null);
  assert.equal(new URL(url).hostname,'chatgpt.com');
  return Response.json({error:{message:'private@account.example quota exhausted'}},{status:429});
 });
 const response=await handler(new Request('https://gateway/v1/responses',{method:'POST',headers:{authorization:'Bearer session','x-s2a-frontend':'1'},body:JSON.stringify({model:'gpt-6.1-sol',input:'hello'})}));
 assert.equal(response.status,429);
 const body=await response.text();assert.equal(JSON.parse(body).error.type,'upstream_rejected_request');assert.equal(body.includes('private@'),false);
 assert.equal(acquisitions,exhausted?2:3);assert.equal(finished,exhausted?1:3);
});
