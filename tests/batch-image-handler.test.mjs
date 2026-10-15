import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackendHandler} from './handler.mjs';
const config={url:'https://project.supabase.co',serviceKey:'private-service',adminIds:[],dataModel:'native'};
const id='imgbatch_'+'a'.repeat(32);
test('canonical gateway handles root and deployed batch paths with API key isolation',async()=>{
 const calls=[],handler=createBackendHandler(config,async(url,init)=>{
  const rpc=String(url).split('/').at(-1),args=JSON.parse(init.body);calls.push(rpc);assert.match(args.p_key_hash,/^[a-f0-9]{64}$/);assert.ok(!init.body.includes('sk-client'));
  if(rpc.endsWith('model_sources'))return Response.json({sources:[]});
  if(rpc.endsWith('_list'))return Response.json({items:[],total:0});
  return Response.json({id,items:[]});
 });
 for(const base of ['/images/batches','/v1/images/batches','/functions/v1/sub2api/v1/images/batches']){
  for(const suffix of ['', '/models','/'+id]){
   const request=new Request('https://gateway'+base+suffix,{headers:{authorization:'Bearer sk-client'}});
   assert.equal((await handler(request)).status,200);
  }
 }
 assert.equal(calls.length,9);assert.ok(calls.every(rpc=>rpc.startsWith('s2a_batch_image_')));
});
test('batch routes reject absent or malformed authentication before native reads',async()=>{
 const handler=createBackendHandler(config,()=>assert.fail('unauthenticated database access'));
 for(const authorization of [undefined,'Basic secret','Bearer']){
  const response=await handler(new Request('https://gateway/images/batches',{headers:authorization?{authorization}:{}}));assert.equal(response.status,401);
 }
});
