import test from 'node:test';
import assert from 'node:assert/strict';
import {anthropicModelCatalog,anthropicCodexCatalog} from '../supabase/functions/sub2api/anthropic_catalog.ts';
import {DEFAULT_PROVIDER_CATALOGS} from '../supabase/functions/sub2api/provider_models.ts';
import {createBackendHandler} from './handler.mjs';

test('Anthropic standard catalogs preserve original fallback metadata and mapped list shapes',()=>{
 assert.deepEqual(anthropicModelCatalog([]).data,DEFAULT_PROVIDER_CATALOGS.anthropic);
 const result=anthropicModelCatalog(['custom']);assert.deepEqual(result.data,[{id:'custom',type:'model',display_name:'custom',created_at:'2024-01-01T00:00:00Z'}]);
 assert.deepEqual(anthropicModelCatalog(['custom'],undefined,'custom'),result.data[0]);assert.throws(()=>anthropicModelCatalog(['custom'],undefined,'hidden'),{status:404});
 const allowlist={enabled:true,models:['custom','claude-sonnet-4-6']};
 assert.deepEqual(anthropicModelCatalog(['custom'],allowlist).data.map(model=>model.id),['custom','claude-sonnet-4-6']);
 assert.equal(anthropicModelCatalog([],allowlist).data[0].created_at,'2024-01-01T00:00:00Z');
});
test('Anthropic Codex catalogs retain alias metadata and empty whitelist results',()=>{
 const result=anthropicCodexCatalog(['public'],undefined,[{platform:'anthropic',type:'service_account',mapping:{public:'claude-sonnet-4-6'},passthrough:false,official:false,modalities:{}}]);
 assert.deepEqual(result.models.map(model=>model.slug),['public']);assert.deepEqual(result.models[0].input_modalities,['text']);
 assert.deepEqual(anthropicCodexCatalog(['public'],{enabled:true,models:['hidden']}),{models:[]});
 assert.ok(anthropicCodexCatalog([]).models.some(model=>model.slug==='claude-sonnet-4-6'));
});
test('native Anthropic discovery and Codex manifests need no credentials, provider I/O or inference slots',async()=>{
 const app=createBackendHandler({url:'https://db.invalid',serviceKey:'private',encryptionKey:'',adminIds:[],dataModel:'native'},async(url)=>{
  if(String(url).endsWith('/s2a_personal_ops_error_record'))return Response.json(null);
  assert.ok(String(url).endsWith('/s2a_personal_acquire'));
  return Response.json({anthropic_catalog:['public'],anthropic_capabilities:[],model_allowlist:{enabled:true,models:['public']}});
 });
 const get=(path,headers={})=>app(new Request('https://gateway'+path,{headers:{authorization:'Bearer sk-client',...headers}}));
 const list=await get('/v1/models');assert.equal(list.status,200);const entry=(await list.json()).data[0];
 const detail=await get('/v1/models/public?client_version=ignored%20invalid%20value');assert.equal(detail.status,200);assert.deepEqual(await detail.json(),entry);
 assert.equal((await get('/v1/models/hidden')).status,404);
 const empty=await get('/v1/models?client_version=');assert.equal((await empty.json()).object,'list');
 const manifest=await get('/v1/models?client_version=1.0');assert.equal(manifest.status,200);assert.equal((await manifest.json()).models[0].slug,'public');
 const etag=manifest.headers.get('etag');assert.match(etag,/^"[a-f0-9]{64}"$/);
 const unchanged=await get('/backend-api/codex/models',{'if-none-match':'W/'+etag});assert.equal(unchanged.status,304);assert.equal(await unchanged.text(),'');
});
