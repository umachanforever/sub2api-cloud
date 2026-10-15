import test from 'node:test';
import assert from 'node:assert/strict';
import {executeBatchImageJob} from '../supabase/functions/sub2api/batch_image_execute.ts';
const job={batch_id:'imgbatch_abc',lease_id:'11111111-1111-1111-1111-111111111111',stage:'upload',recover_create:false};
function setup(){
 const calls=[],db={rpc:async(name,args)=>{calls.push(name);return name.endsWith('_dispatch')?{dispatched:true}:{applied:true};}},deps={provider:{uploadInput:async()=>{calls.push('upload');return {input_ref:'files/in',output_ref:'files/out'};},createUploadedBatch:async()=>{calls.push('create');return {name:'batches/one'};},getBatch:async()=>{calls.push('poll');return {name:'batches/one',status:'running'};}},loadInput:async()=>({model:'gemini-image',items:[{custom_id:'cover',prompt:'blue square'}]}),saveCreated:async()=>{calls.push('receipt');},loadCreated:async()=>null,index:async()=>{calls.push('index');return true;}};
 return {calls,db,deps};
}
test('batch execution persists upload and dispatch before creation and receipt before database acknowledgement',async()=>{
 const {calls,db,deps}=setup();assert.equal(await executeBatchImageJob(db,job,deps),true);assert.deepEqual(calls,['upload','s2a_batch_image_runtime_checkpoint','s2a_batch_image_runtime_dispatch','create','receipt','s2a_batch_image_runtime_created']);
});
test('uncertain create acknowledgement never triggers a second upstream creation',async()=>{
 const {calls,db,deps}=setup();db.rpc=async(name)=>{calls.push(name);if(name.endsWith('_dispatch'))throw Error('ack lost');return {applied:true};};assert.equal(await executeBatchImageJob(db,job,deps),false);assert.ok(!calls.includes('create'));
 calls.length=0;db.rpc=async(name)=>{calls.push(name);return {applied:true};};assert.equal(await executeBatchImageJob(db,{...job,stage:'create',recover_create:true},deps),true);assert.deepEqual(calls,['s2a_batch_image_runtime_fail']);
});
test('creation recovery binds a saved receipt without reading input or posting again',async()=>{
 const {calls,db,deps}=setup();deps.loadCreated=async()=>'batches/saved';deps.loadInput=()=>assert.fail('recovery loaded original request');assert.equal(await executeBatchImageJob(db,{...job,stage:'create',recover_create:true},deps),true);assert.deepEqual(calls,['s2a_batch_image_runtime_created']);
});
test('polling forwards bounded status into fenced SQL and indexing uses a separate stage',async()=>{
 const {calls,db,deps}=setup();assert.equal(await executeBatchImageJob(db,{...job,stage:'poll',provider_job_name:'batches/one'},deps),true);assert.deepEqual(calls,['poll','s2a_batch_image_runtime_observed']);calls.length=0;assert.equal(await executeBatchImageJob(db,{...job,stage:'index'},deps),true);assert.deepEqual(calls,['index']);
});
test('failed receipt storage leaves uncertain creation for recovery and rejects invalid job identities',async()=>{
 const {calls,db,deps}=setup();deps.saveCreated=async()=>{throw Error('storage down');};assert.equal(await executeBatchImageJob(db,job,deps),false);assert.equal(calls.filter(value=>value==='create').length,1);assert.ok(!calls.includes('s2a_batch_image_runtime_created'));
 await assert.rejects(executeBatchImageJob(db,{...job,lease_id:'bad'},deps),/invalid_batch_runtime_job/);
});
