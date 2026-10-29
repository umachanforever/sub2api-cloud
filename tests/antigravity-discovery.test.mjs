import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createBackendHandler} from './handler.mjs';
import {ANTIGRAVITY_MODELS} from '../supabase/functions/sub2api/antigravity_catalog.ts';
import {hashKey} from '../supabase/functions/sub2api/validation.ts';
const config={url:'https://database.invalid',serviceKey:'private',encryptionKey:'',adminIds:[],dataModel:'native'};
test('Antigravity discovery preserves the pinned upstream catalog including metadata and order',async()=>{
 const source=await readFile(new URL('../backend/internal/pkg/antigravity/claude_types.go',import.meta.url),'utf8');
 const section=source.slice(source.indexOf('var claudeModels'),source.indexOf('// ========== Claude API'));
 const expected=[...section.matchAll(/ID: "([^"]+)", DisplayName: "([^"]+)", CreatedAt: "([^"]+)"/g)].map(([,id,display_name,created_at])=>({id,type:'model',display_name,created_at}));
 assert.equal(expected.length,48);assert.deepEqual(ANTIGRAVITY_MODELS,expected);
});
test('static discovery enforces native key policy without account admission or provider credentials',async()=>{
 let lookups=0;const handler=createBackendHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_key_policy')){lookups++;const args=JSON.parse(init.body);assert.equal(args.p_key_hash,await hashKey('sk-client'));assert.equal(args.p_client_ip,'192.0.2.5');return Response.json({model_allowlist:{enabled:true,models:['gemini-2.5-flash']}});}
  if(String(url).includes('/rpc/'))return Response.json(null);
  assert.fail('Static discovery must not contact a provider');
 });
 const response=await handler(new Request('https://gateway/functions/v1/sub2api/antigravity/models',{headers:{authorization:'Bearer sk-client','x-real-ip':'192.0.2.5'}}));
 assert.equal(response.status,200);const value=await response.json();assert.equal(value.object,'list');assert.deepEqual(value.data.map(model=>model.id),['gemini-2.5-flash','gemini-2.5-flash-thinking']);assert.equal(lookups,1);assert.equal(response.headers.get('cache-control'),'no-store');
});
test('static discovery rejects missing, revoked and network-restricted credentials',async()=>{
 for(const [error,status] of [['invalid_api_key',401],['ip_forbidden',403],['user_disabled',403]]){
  const handler=createBackendHandler(config,async(url)=>Response.json(String(url).endsWith('/s2a_personal_key_policy')?{error,status}:null));
  const missing=await handler(new Request('https://gateway/antigravity/models'));assert.equal(missing.status,401);
  const response=await handler(new Request('https://gateway/antigravity/models',{headers:{authorization:'Bearer sk-revoked'}}));assert.equal(response.status,status);assert.equal((await response.json()).error.type,error);
 }
});
test('Antigravity static discovery accepts native keys and rejects conflicting credentials',async()=>{
 let calls=0;const handler=createBackendHandler(config,async(url)=>{
  if(String(url).endsWith('/s2a_personal_key_policy')){calls++;return Response.json({model_allowlist:{enabled:false,models:[]}});}
  return Response.json(null);
 });
 const response=await handler(new Request('https://gateway/antigravity/models',{headers:{'x-api-key':'sk-native'}}));assert.equal(response.status,200);assert.equal((await response.json()).data.length,48);
 const conflict=await handler(new Request('https://gateway/antigravity/models',{headers:{'x-api-key':'sk-native',authorization:'Bearer sk-other'}}));assert.equal(conflict.status,400);assert.equal(calls,1);
});
