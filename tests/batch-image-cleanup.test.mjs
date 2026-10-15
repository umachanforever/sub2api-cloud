import test from 'node:test';
import assert from 'node:assert/strict';
import {Database} from '../supabase/functions/sub2api/db.ts';
import {cleanupBatchImages} from '../supabase/functions/sub2api/batch_image_cleanup.ts';
const id='imgbatch_'+'a'.repeat(32),lease='11111111-1111-1111-1111-111111111111';
test('batch cleanup deletes bounded pages and verifies metadata is empty before finishing',async()=>{
 let entries=[{name:'request.json'},{name:'created.json'},...Array.from({length:200},(_,i)=>({name:`item-${i+1}.json`}))],finished=false;const sizes=[],db=new Database({url:'https://db.invalid',serviceKey:'service'},async(url,init)=>{
  if(String(url).endsWith('_claim'))return Response.json([{batch_id:id,cleanup_lease:lease,provider:'gemini_api',account_id:'1'}]);
  if(String(url).endsWith('_finish')){assert.equal(entries.length,0);finished=true;return Response.json({applied:true});}
  if(String(url).includes('/object/list/'))return Response.json(entries);
  const paths=JSON.parse(init.body).prefixes;sizes.push(paths.length);entries=entries.filter(entry=>!paths.includes(`batches/${id}/${entry.name}`));return Response.json({});
 });let provider=false;assert.equal(await cleanupBatchImages(db,async()=>{provider=true;}),1);assert.equal(provider,true);assert.equal(finished,true);assert.deepEqual(sizes,[100,100,2]);
});
test('provider failure or remaining private files never acknowledges cleanup',async()=>{
 for(const failProvider of [true,false]){let finished=false;const db=new Database({url:'https://db.invalid',serviceKey:'service'},async(url)=>{if(String(url).endsWith('_claim'))return Response.json([{batch_id:id,cleanup_lease:lease,provider:'gemini_api',account_id:'1'}]);if(String(url).endsWith('_finish'))finished=true;if(String(url).includes('/object/list/'))return Response.json([{name:'request.json'}]);return Response.json({});});assert.equal(await cleanupBatchImages(db,async()=>{if(failProvider)throw Error('provider down');}),0);assert.equal(finished,false);}
});
