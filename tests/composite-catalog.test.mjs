import test from 'node:test';
import assert from 'node:assert/strict';
import {compositeModelCatalog} from '../supabase/functions/sub2api/composite_catalog.ts';
const source=(platform,mapping={},passthrough=false)=>({platform,mapping,passthrough});
const route=(model,match_type='exact')=>({model,match_type,platform:'openai',endpoint:'any',upstream_model:'gpt-6-sol'});
const ids=(sources,routes=[],allowlist)=>compositeModelCatalog({sources,routes},allowlist).data.map(entry=>entry.id);
test('Composite catalogs aggregate platforms, exact route aliases and account wildcard mappings',()=>{
 assert.deepEqual(ids([source('grok',{'grok-public':'grok-4.6'}),source('openai',{'gpt-public':'gpt-6-sol','family*':'gpt-6-sol'})],[route('route-public'),route('prefix-','prefix'),route('gpt-public')]),['family*','gpt-public','grok-public','route-public']);
});
test('OpenAI passthrough and unmapped accounts preserve defaults beside other account aliases',()=>{
 for(const account of [source('openai'),source('openai',{stale:'gpt-5.5'},true)]){
  const result=ids([source('openai',{custom:'gpt-6-sol'}),account]);assert.ok(result.includes('gpt-6.1-sol'));assert.ok(result.includes('custom'));assert.ok(!result.includes('stale'));
 }
 assert.ok(!ids([source('deepseek')]).includes('deepseek-flash'));
 assert.ok(!ids([]).includes('jev-latest'));
 assert.ok(ids([]).includes('gpt-6.1-sol'));
 assert.ok(ids([source('grok')]).includes('grok-4.7'));
 assert.ok(ids([source('typesafe')]).includes('jev-latest'));
});
test('Composite allowlists expand configured wildcards and detail lookup cannot bypass the list',()=>{
 const input={sources:[source('openai',{'public*':'gpt-6-sol',hidden:'gpt-6-sol'})],routes:[]};
 const policy={enabled:true,models:['public-version']};
 assert.deepEqual(compositeModelCatalog(input,policy).data.map(entry=>entry.id),['public-version']);
 assert.equal(compositeModelCatalog(input,policy,'public-version').id,'public-version');
 assert.throws(()=>compositeModelCatalog(input,policy,'hidden'),{status:404});
 assert.throws(()=>compositeModelCatalog(input,undefined,'missing'),{status:404});
});
import {createHandler} from './handler.mjs';
test('native standard Composite catalog dispatch needs neither provider fetch nor an inference lease',async()=>{
 const calls=[];
 const app=createHandler({url:'https://db.invalid',serviceKey:'service',encryptionKey:'',adminIds:[],dataModel:'native'},async(url,init)=>{
  const rpc=String(url).split('/').at(-1);calls.push(rpc);
  assert.equal(rpc,'s2a_personal_acquire');
  const args=JSON.parse(init.body);assert.equal(args.p_model,'__models__');assert.match(args.p_key_hash,/^[a-f0-9]{64}$/);
  return Response.json({composite_catalog:{sources:[source('openai',{public:'gpt-6-sol'})],routes:[route('route-public')]},model_allowlist:{enabled:true,models:['public']}});
 });
 const response=await app(new Request('https://gateway/v1/models',{headers:{authorization:'Bearer sk-client'}}));
 assert.equal(response.status,200);assert.deepEqual((await response.json()).data.map(entry=>entry.id),['public']);assert.deepEqual(calls,['s2a_personal_acquire']);
 const detail=await app(new Request('https://gateway/v1/models/public',{headers:{authorization:'Bearer sk-client'}}));assert.equal(detail.status,200);assert.equal((await detail.json()).id,'public');
 const missing=await app(new Request('https://gateway/v1/models/route-public',{headers:{authorization:'Bearer sk-client'}}));assert.equal(missing.status,404);
});

test('Composite catalogs retain Command Code and Cline configured model ownership',()=>{
 assert.deepEqual(ids([source('command_code',{'command/custom':'model'}),source('cline',{'cline/custom':'model'})]),['command/custom','cline/custom']);
});
test('provider-prefixed model detail supports encoded separators and rejects unsafe paths before acquisition',async()=>{
 let acquisitions=0;
 const app=createHandler({url:'https://db.invalid',serviceKey:'service',encryptionKey:'',adminIds:[],dataModel:'native'},async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_acquire')){acquisitions++;return Response.json({composite_catalog:{sources:[source('grok',{'xai/grok-4.6':'grok-4.6'})],routes:[]}});}
  return Response.json(true);
 });
 const get=id=>app(new Request('https://gateway/v1/models/'+id,{headers:{authorization:'Bearer sk-client'}}));
 const response=await get('xai%2Fgrok-4.6');assert.equal(response.status,200);assert.equal((await response.json()).id,'xai/grok-4.6');assert.equal(acquisitions,1);
 for(const id of ['xai%2F..%2Fsecret','xai%2F.%2Fsecret','xai%2F%2Fsecret','xai%2Fgrok%3Fkey=secret','xai%2Fgrok%23secret','xai%252Fgrok','%E0%A4%A'])assert.equal((await get(id)).status,400,id);
 assert.equal(acquisitions,1);
});
