import assert from 'node:assert/strict';
import test from 'node:test';
import { administrator, deploymentMode, localProject } from '../scripts/up.mjs';
import { validateConfig } from '../scripts/console.mjs';
const key = 'sb_publishable_12345678901234567890';
test('deployment modes are explicit and local origins never relax cloud validation', () => {
  assert.equal(deploymentMode({}, []), 'cloud');
  assert.equal(deploymentMode({SUPABASE_MODE:'cloud'}, ['--local']), 'local');
  assert.throws(() => deploymentMode({}, ['--local','--cloud']));
  assert.throws(() => deploymentMode({SUPABASE_MODE:'unknown'}, []));
  for (const host of ['localhost','127.0.0.1','host.docker.internal']) assert.equal(validateConfig({mode:'local',supabase_url:`http://${host}:54321`,publishable_key:key}).supabase_url,`http://${host}:54321`);
  for (const [mode,url] of [['cloud','http://localhost:54321'],['local','https://project.supabase.co'],['local','http://evil.example:54321'],['local','http://localhost:54321/private']]) assert.throws(() => validateConfig({mode,supabase_url:url,publishable_key:key}));
  const result=localProject({API_URL:'http://127.0.0.1:54321',ANON_KEY:key,SERVICE_ROLE_KEY:'local-service'});
  assert.equal(result.containerURL,'http://host.docker.internal:54321');assert.equal(result.SUPABASE_MODE,'local');
});
test('administrator setup reuses correct credentials and never resets existing accounts', async () => {
  const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'private',SUB2API_LOCAL_ADMIN_EMAIL:'admin@example.com',SUB2API_LOCAL_ADMIN_PASSWORD:'local-password'};
  let calls=0;
  assert.equal(await administrator(env,async()=>{calls++;return Response.json({user:{id:'user'}});}), 'user');assert.equal(calls,1);
  const paths=[];
  assert.equal(await administrator(env,async(url,init)=>{paths.push(url);if(url.includes('grant_type')) return Response.json({},{status:400});if(url.includes('/rpc/s2a_registration_authorize'))return Response.json({token:'a'.repeat(64)});assert.equal(JSON.parse(init.body).email_confirm,true);return Response.json({id:'created'});}), 'created');assert.equal(paths.length,3);
  await assert.rejects(administrator(env,async()=>Response.json({secret:'must not leak'},{status:422})),/login unavailable/);
});
