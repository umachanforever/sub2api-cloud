import test from 'node:test';
import assert from 'node:assert/strict';
import {Database} from '../supabase/functions/sub2api/db.ts';
import {storeBatchRequest,loadBatchRequest,storeBatchCreated,loadBatchCreated} from '../supabase/functions/sub2api/batch_image_storage.ts';
const batchID='imgbatch_'+'a'.repeat(32),signal=()=>AbortSignal.timeout(5000);
function fixture(){const files=new Map();const db=new Database({url:'https://db.invalid',serviceKey:'private-service'},async(url,init)=>{
 const path=new URL(url).pathname.replace('/storage/v1/object/authenticated/','').replace('/storage/v1/object/','');assert.equal(new Headers(init.headers).get('authorization'),'Bearer private-service');assert.equal(init.redirect,'error');
 if(init.method==='POST'){assert.equal(new Headers(init.headers).get('content-type'),'application/octet-stream');files.set(path,new Uint8Array(init.body));return Response.json({});}
 return files.has(path)?new Response(files.get(path)):Response.json({statusCode:'404',error:'not_found'},{status:400});
 });return {db,files};}
test('batch requests and receipts roundtrip through private storage with request and provider bindings',async()=>{
 const {db}=fixture(),saved=await storeBatchRequest(db,batchID,{model:'gemini-image',items:[{custom_id:'cover',prompt:'blue square',output_count:2}]},signal()),binding={batchID,requestHash:saved.requestHash,provider:'gemini_api'};
 assert.equal((await loadBatchRequest(db,binding,signal())).items.length,2);assert.equal(await loadBatchCreated(db,binding,signal()),null);await storeBatchCreated(db,binding,'batches/one',signal());assert.equal(await loadBatchCreated(db,binding,signal()),'batches/one');
 await assert.rejects(loadBatchRequest(db,{...binding,requestHash:'b'.repeat(64)},signal()),/hash_mismatch/);await assert.rejects(loadBatchCreated(db,{...binding,requestHash:'b'.repeat(64)},signal()),/binding_mismatch/);
});
test('batch artifact validation rejects escaped paths and oversized or malformed receipts',async()=>{
 const {db,files}=fixture(),binding={batchID,requestHash:'a'.repeat(64),provider:'gemini_api'};
 await assert.rejects(storeBatchCreated(db,{...binding,batchID:'../other'},'batches/one',signal()));await assert.rejects(storeBatchCreated(db,binding,'https://evil.example/',signal()));assert.equal(files.size,0);
 const path='sub2api-artifacts/batches/'+batchID+'/created.json';files.set(path,new TextEncoder().encode('x'.repeat(16385)));await assert.rejects(loadBatchCreated(db,binding,signal()),/invalid_batch_artifact/);
 files.set(path,new TextEncoder().encode('{}'));await assert.rejects(loadBatchCreated(db,binding,signal()),/binding_mismatch/);
});
