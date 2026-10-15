import assert from 'node:assert/strict';
import test from 'node:test';
import {disableOpenAITraining,ensureOpenAIPrivacy} from '../supabase/functions/sub2api/openai_privacy.ts';
import {Database} from '../supabase/functions/sub2api/db.ts';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
import {createHandler} from './handler.mjs';
const id='22222222-2222-4222-8222-222222222222',user='11111111-1111-4111-8111-111111111111';
const config={url:'https://db.example',serviceKey:'service',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[user]};
const encrypted=await encryptCredentials({access_token:'private-token',refresh_token:'private-refresh',chatgpt_account_id:'account'},config.encryptionKey);
const row={id,...encrypted,credential_version:4,platform:'openai',type:'oauth',extra:{email:'keep@example.com'}};
test('privacy uses fixed origin, bearer, timeout and rejects redirects without exposing upstream bodies',async()=>{
 let called=false;
 const result=await disableOpenAITraining('private-token',async(url,init)=>{
  called=true;assert.equal(String(url),'https://chatgpt.com/backend-api/settings/account_user_setting?feature=training_allowed&value=false');
  assert.equal(init.method,'PATCH');assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,'Bearer private-token');
  assert.equal(init.headers.origin,'https://chatgpt.com');assert.ok(init.signal instanceof AbortSignal);return new Response(null,{status:204});
 });assert.equal(called,true);assert.equal(result,'training_off');
 for(const [status,body,headers,expected] of [[403,'Just a moment',{},'training_set_cf_blocked'],[503,'secret',{'cf-mitigated':'challenge'},'training_set_cf_blocked'],[403,'private-token',{},'training_set_failed'],[429,'cloudflare',{},'training_set_failed']])
  assert.equal(await disableOpenAITraining('token',async()=>new Response(body,{status,headers})),expected);
 assert.equal(await disableOpenAITraining('token',async()=>{throw new Error('secret');}),'training_set_failed');
 assert.equal(await disableOpenAITraining('',async()=>{throw new Error('unexpected');}),'');
});
test('automatic ensure skips completed/custom modes, retries failure and saves with credential and metadata CAS',async()=>{
 for(const previous of [undefined,'training_set_failed','training_set_cf_blocked','training_off','','custom',null]) {
  let upstream=0,saves=0;
  const db=new Database(config,async(url,init)=>{
   if(String(url).includes('/s2a_accounts?'))return Response.json([{...row,extra:{...row.extra,...(previous===undefined?{}:{privacy_mode:previous})}}]);
   if(String(url).startsWith('https://chatgpt.com/')){upstream++;return new Response(null,{status:204});}
   saves++;assert.ok(String(url).endsWith('/s2a_account_privacy_save'));assert.deepEqual(JSON.parse(init.body),{p_account_id:id,p_version:4,p_previous:previous??null,p_mode:'training_off'});return Response.json(true);
  });await ensureOpenAIPrivacy(db,id);
  const expected=[undefined,null,'','training_set_failed','training_set_cf_blocked'].includes(previous)?1:0;assert.equal(upstream,expected);assert.equal(saves,expected);
 }
});
test('unsupported and missing accounts never contact the provider',async()=>{
 for(const rows of [[],[{...row,type:'apikey'}],[{...row,platform:'anthropic'}]]) {
  const db=new Database(config,async(url)=>{assert.ok(String(url).includes('/s2a_accounts?'));return Response.json(rows);});
  await assert.rejects(ensureOpenAIPrivacy(db,id,true),{status:rows.length?400:404});
 }
});

test('native credential refresh persists privacy for the rotated token before returning',async()=>{
 const {credentialsFor}=await import('../supabase/functions/sub2api/accounts.ts');
 const expiring=await encryptCredentials({access_token:'old',refresh_token:'refresh',expires_at:1},config.encryptionKey);
 let stored,providerCalls=0,privacyCalls=0,saves=0,released=false;
 const db=new Database(config,async(url,init)=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/s2a_refresh_acquire'))return Response.json(true);
  if(path.endsWith('/oauth/token')){providerCalls++;return Response.json({access_token:'new',refresh_token:'rotated',expires_in:3600});}
  if(path.endsWith('/s2a_refresh_save')){stored=JSON.parse(init.body);return Response.json(true);}
  if(path.endsWith('/s2a_accounts'))return Response.json([{...row,ciphertext:stored.p_ciphertext,iv:stored.p_iv,credential_version:5}]);
  if(String(url).startsWith('https://chatgpt.com/')){privacyCalls++;assert.equal(init.headers.authorization,'Bearer new');return new Response(null,{status:204});}
  if(path.endsWith('/s2a_account_privacy_save')){saves++;assert.equal(JSON.parse(init.body).p_version,5);return Response.json(true);}
  assert.ok(path.endsWith('/s2a_refresh_release'));released=true;return Response.json(null);
 });
 const account={id,...expiring,credential_version:4};const credentials=await credentialsFor(db,account);
 assert.equal(credentials.access_token,'new');assert.equal(account.credential_version,5);assert.equal(providerCalls,1);assert.equal(privacyCalls,1);assert.equal(saves,1);assert.equal(released,true);
});
