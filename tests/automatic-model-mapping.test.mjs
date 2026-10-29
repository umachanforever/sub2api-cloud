import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeResponse} from '../supabase/functions/sub2api/api_key_provider.ts';

test('model discovery is saved before aliases and group filtering and before releasing the lease',async()=>{
 const saved=[],order=[];
 const response=await nativeResponse(Response.json({models:[{name:'models/gemini-new'},{name:'models/claude-new'},{name:'models/gemini-4-argon-disabled'}]}),'antigravity','models',false,new AbortController().signal,'request',async()=>order.push('finish'),'/v1/models',{enabled:true,models:['alias']},{mapping:{alias:'gemini-new'},include_upstream:true},undefined,Date.now(),undefined,async value=>{saved.push(value);order.push('save');});
 assert.deepEqual(saved[0]?.data.map(row=>row.id),['gemini-new','claude-new','gemini-4-argon-disabled']);
 assert.deepEqual(order,['save','finish']);
 assert.deepEqual((await response.json()).data.map(row=>row.id),['alias']);
});
test('partial catalog pages do not replace the automatic model snapshot',async()=>{
 let saves=0;
 await nativeResponse(Response.json({models:[{name:'models/gemini-new'}],nextPageToken:'next'}),'antigravity','models',false,new AbortController().signal,'request',async()=>{},'/v1beta/models',undefined,undefined,undefined,Date.now(),undefined,async()=>saves++);
 assert.equal(saves,0);
});

test('has_more pages and individual model details are never published as full catalogs',async()=>{
 for(const [body,path] of [[{models:[{name:'models/gemini-new'}],has_more:true},'/v1/models'],[{name:'models/gemini-new'},'/v1beta/models/gemini-new']]){
  let saves=0;
  await nativeResponse(Response.json(body),'antigravity','models',false,new AbortController().signal,'request',async()=>{},path,undefined,undefined,undefined,Date.now(),undefined,async()=>saves++);
  assert.equal(saves,0);
 }
});
