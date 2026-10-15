import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveProjectCredentials} from '../scripts/project-credentials.mjs';
const jwt=claims=>'header.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.signature';
const env={SUPABASE_URL:'https://project.supabase.co',SUPABASE_ACCESS_TOKEN:'management-secret'};

test('explicit service-role keys need no Management API request',async()=>{
 const explicit={SUPABASE_SERVICE_ROLE_KEY:'configured'};
 assert.equal(await resolveProjectCredentials(explicit,()=>assert.fail()),explicit);
});
test('missing service-role key is fetched for the configured project without mutating configuration',async()=>{
 const key=jwt({role:'service_role',ref:'project'});
 const result=await resolveProjectCredentials(env,async(url,init)=>{
  assert.equal(url,'https://api.supabase.com/v1/projects/project/api-keys');
  assert.equal(init.headers.authorization,'Bearer management-secret');assert.equal(init.redirect,'error');
  return Response.json([{name:'anon',api_key:'public'},{name:'service_role',api_key:key}]);
 });
 assert.equal(result.SUPABASE_SERVICE_ROLE_KEY,key);assert.equal(env.SUPABASE_SERVICE_ROLE_KEY,undefined);
});
test('automatic retrieval rejects invalid routes, wrong project keys and unprivileged keys',async()=>{
 for(const url of ['http://project.supabase.co','https://project.supabase.co.evil.test','https://user@project.supabase.co','https://project.supabase.co/path'])await assert.rejects(resolveProjectCredentials({...env,SUPABASE_URL:url},()=>assert.fail()),/hosted/);
 for(const claims of [{role:'anon',ref:'project'},{role:'service_role',ref:'other'}])await assert.rejects(resolveProjectCredentials(env,async()=>Response.json([{name:'service_role',api_key:jwt(claims)}])),/did not return/);
 await assert.rejects(resolveProjectCredentials({SUPABASE_URL:env.SUPABASE_URL}),/SUPABASE_ACCESS_TOKEN/);
});
test('retrieval failures never include response bodies, credentials or network error details',async()=>{
 for(const fetcher of [async()=>new Response('private-response-secret',{status:403}),async()=>{throw Error('management-secret')},async()=>new Response('private-response-secret')]){
  await assert.rejects(resolveProjectCredentials(env,fetcher),error=>!error.message.includes('secret'));
 }
});
