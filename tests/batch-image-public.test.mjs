import test from 'node:test';
import assert from 'node:assert/strict';
import {publicBatchImage,publicBatchImageItem} from '../supabase/functions/sub2api/batch_image_public.ts';
test('batch responses use original public states, Unix timestamps and safe fields',()=>{
 for(const [native,expected] of [['created','queued'],['submitted','queued'],['indexing','processing_results'],['completed','completed']]){
  const row=publicBatchImage({id:'batch',status:native,created_at:'2026-01-01T00:00:00Z',submitted_at:'2026-01-01T00:01:00Z',account_id:1,request_hash:'private',items:[{provider_source_object:'private'}]});
  assert.equal(row.status,expected);assert.equal(row.created_at,1767225600);assert.equal(row.submitted_at,1767225660);assert.equal(row.actual_cost,null);assert.equal(row.estimated_cost,0);
  for(const field of ['account_id','request_hash','items'])assert.ok(!(field in row));
 }
 assert.throws(()=>publicBatchImage({created_at:'invalid'}),/invalid_batch_timestamp/);
});
test('item responses expose succeeded status and bounded errors without provider messages',()=>{
 const ok=publicBatchImageItem({custom_id:'cover',status:'success',image_count:1});assert.equal(ok.status,'succeeded');assert.equal(ok.error,null);assert.equal(ok.mime_type,null);
 const failed=publicBatchImageItem({custom_id:'cover',status:'failed',error_code:'SAFETY_BLOCKED',error_message:'provider-secret',provider_source_object:'private'});assert.deepEqual(failed.error,{code:'SAFETY_BLOCKED',message:'SAFETY_BLOCKED'});assert.ok(!JSON.stringify(failed).includes('provider-secret'));
});
