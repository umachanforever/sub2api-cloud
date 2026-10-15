import test from 'node:test';
import assert from 'node:assert/strict';
import {Database} from '../supabase/functions/sub2api/db.ts';
import {submitBatchImage} from '../supabase/functions/sub2api/batch_image_submit.ts';
const id='imgbatch_'+'a'.repeat(32),hash='b'.repeat(64),input={model:'gemini-image',task_name:'images',items:[{prompt:'blue square',output_count:2}]};
test('batch submission admits before private upload and enables queue only after persistence',async()=>{
 const calls=[],db=new Database({url:'https://db.invalid',serviceKey:'service',dataModel:'native'},async(url,init)=>{calls.push(String(url));if(String(url).includes('/rpc/')){const body=JSON.parse(init.body);if(String(url).endsWith('_prepare')){assert.equal(body.p_count,2);assert.match(body.p_hash,/^[a-f0-9]{64}$/);}return Response.json({id,ready:String(url).endsWith('_ready')});}assert.equal(JSON.parse(new TextDecoder().decode(init.body)).items.length,2);return Response.json({});});
 assert.deepEqual(await submitBatchImage(db,hash,input,{id}),{id,ready:true});assert.equal(calls.length,3);assert.ok(calls[0].endsWith('_prepare'));assert.ok(calls[1].endsWith('request.json'));assert.ok(calls[2].endsWith('_ready'));
});
test('denied admission and failed storage never make a batch claimable',async()=>{
 for(const denied of [true,false]){const calls=[],db=new Database({url:'https://db.invalid',serviceKey:'service',dataModel:'native'},async(url)=>{calls.push(String(url));if(String(url).includes('/rpc/'))return Response.json(denied?{error:'batch_image_generation_forbidden',status:403}:{id,ready:false});return Response.json({},{status:503});});await assert.rejects(submitBatchImage(db,hash,input,{id}));assert.ok(!calls.some(url=>url.endsWith('_ready')));assert.equal(calls.length,denied?1:2);}
});
test('an already persisted batch replay does not upload or enqueue again',async()=>{
 let calls=0;const db=new Database({url:'https://db.invalid',serviceKey:'service',dataModel:'native'},async()=>{calls++;return Response.json({id,ready:true});});await submitBatchImage(db,hash,input,{id});assert.equal(calls,1);
});
