import test from 'node:test';
import assert from 'node:assert/strict';
import {Database} from '../supabase/functions/sub2api/db.ts';
import {batchImageContent} from '../supabase/functions/sub2api/batch_image_content.ts';
const id='imgbatch_'+'a'.repeat(32),hash='b'.repeat(64);
test('batch content authorizes native item ownership before returning private image bytes',async()=>{
 const calls=[],db=new Database({url:'https://db.invalid',serviceKey:'service'},async(url)=>{calls.push(String(url));return String(url).includes('/rpc/')?Response.json({custom_id:'cover',path:`batches/${id}/item-1.json`,image_count:1}):Response.json({custom_id:'cover',images:[{mime_type:'image/png',extension:'png',data:'YQ=='}]});});
 const response=await batchImageContent(db,hash,id,'cover');assert.equal(await response.text(),'a');assert.equal(response.headers.get('content-type'),'image/png');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(calls.length,2);
});
test('batch content rejects unauthorized, expired, mismatched and out-of-range reads before storage',async()=>{
 for(const resolved of [{error:'batch_image_forbidden',status:403},{error:'batch_image_output_expired',status:410},{custom_id:'cover',path:`batches/${id}/item-1.json`,image_count:0},{custom_id:'cover',path:'batches/other/item-1.json',image_count:1}]){let calls=0;const db=new Database({url:'https://db.invalid',serviceKey:'service'},async()=>{calls++;return Response.json(resolved);});await assert.rejects(batchImageContent(db,hash,id,'cover'));assert.equal(calls,1);}
});
test('batch content never emits a malformed image or a different item from private storage',async()=>{
 for(const value of [{custom_id:'other',images:[]},{custom_id:'cover',images:[{mime_type:'text/html',data:'YQ=='}]},{custom_id:'cover',images:[{mime_type:'image/png',data:'invalid!'}]}]){const db=new Database({url:'https://db.invalid',serviceKey:'service'},async(url)=>Response.json(String(url).includes('/rpc/')?{custom_id:'cover',path:`batches/${id}/item-1.json`,image_count:1}:value));await assert.rejects(batchImageContent(db,hash,id,'cover'),/invalid_batch_image_artifact/);}
});
