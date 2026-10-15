import test from 'node:test';
import assert from 'node:assert/strict';
import {Database} from '../supabase/functions/sub2api/db.ts';
import {indexBatchImageResults} from '../supabase/functions/sub2api/batch_image_index.ts';
const job={batch_id:'imgbatch_'+'a'.repeat(32),lease_id:'11111111-1111-1111-1111-111111111111'},input={model:'gemini-image',items:[{custom_id:'cover',prompt:'blue'},{custom_id:'missing',prompt:'green'}]};
const line=id=>JSON.stringify({key:id,response:{candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:'YQ=='}}]}}]}});
async function* chunks(ids){for(const id of ids)yield new TextEncoder().encode(line(id)+'\n');}
test('index reconciles submitted IDs and stores images privately before atomic metadata completion',async()=>{
 const calls=[],db=new Database({url:'https://db.invalid',serviceKey:'service'},async(url,init)=>{calls.push(String(url));if(String(url).includes('/rpc/')){const body=JSON.parse(init.body);assert.equal(body.p_items.length,2);assert.equal(body.p_items[0].status,'success');assert.equal(body.p_items[1].error_code,'PROVIDER_RESULT_MISSING');assert.ok(!init.body.includes('YQ=='));return Response.json({applied:true});}const saved=JSON.parse(new TextDecoder().decode(init.body));assert.equal(saved.images[0].data,'YQ==');return Response.json({});});
 assert.equal(await indexBatchImageResults(db,job,input,chunks(['unknown','cover']),AbortSignal.timeout(5000)),true);assert.equal(calls.length,2);assert.ok(calls[0].endsWith('/item-1.json'));assert.ok(calls[1].endsWith('s2a_batch_image_runtime_indexed'));
});
test('index never marks duplicate results or failed media writes complete',async()=>{
 for(const failStorage of [false,true]){let completed=false;const db=new Database({url:'https://db.invalid',serviceKey:'service'},async(url)=>{if(String(url).includes('/rpc/'))completed=true;return Response.json({}, {status:failStorage?503:200});});await assert.rejects(indexBatchImageResults(db,job,input,chunks(['cover','cover']),AbortSignal.timeout(5000)));assert.equal(completed,false);}
});
