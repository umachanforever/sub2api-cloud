import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackendHandler} from './handler.mjs';
import {hashKey} from '../supabase/functions/sub2api/validation.ts';
const config={url:'https://database.invalid',serviceKey:'private',encryptionKey:'',adminIds:[],dataModel:'native'};
test('key billing authenticates without reserving an account or exposing private policy',async()=>{
 const expected={object:'sub2api.key_billing',schema_version:1,billing_scope:'token',group_rate_multiplier:1,resolved_rate_multiplier:0,peak_rate_enabled:false,effective_rate_multiplier:0,observed_at:'2026-10-15T00:00:00Z'};
 let calls=0;const handler=createBackendHandler(config,async(url,init)=>{
  assert.ok(String(url).endsWith('/s2a_personal_key_billing'));calls++;
  assert.deepEqual(JSON.parse(init.body),{p_key_hash:await hashKey('sk-client'),p_client_ip:'192.0.2.5'});return Response.json(expected);
 });
 const response=await handler(new Request('https://gateway/functions/v1/sub2api/v1/sub2api/billing',{headers:{authorization:'Bearer sk-client','x-real-ip':'192.0.2.5'}}));
 assert.equal(response.status,200);assert.deepEqual(await response.json(),expected);assert.equal(calls,1);assert.equal(response.headers.get('cache-control'),'no-store');
});
test('key billing rejects missing, revoked and IP-restricted credentials',async()=>{
 for(const [error,status] of [['invalid_api_key',401],['ip_forbidden',403],['user_disabled',403]]){
  const handler=createBackendHandler(config,async(url)=>{assert.ok(String(url).endsWith('/s2a_personal_key_billing'));return Response.json({error,status});});
  assert.equal((await handler(new Request('https://gateway/v1/sub2api/billing'))).status,401);
  const response=await handler(new Request('https://gateway/v1/sub2api/billing',{headers:{authorization:'Bearer sk-revoked'}}));assert.equal(response.status,status);assert.equal((await response.json()).error.type,error);
 }
});
test('read-only usage-link keys cannot authenticate billing',async()=>{
 let calls=0;const handler=createBackendHandler(config,async(url)=>{if(String(url).endsWith('/s2a_personal_key_billing'))calls++;return Response.json(null);});
 const response=await handler(new Request('https://gateway/v1/sub2api/billing?key=sk-usage-'+ 'a'.repeat(64)));assert.equal(response.status,401);assert.equal(calls,0);
});
