import test from 'node:test';
import assert from 'node:assert/strict';
import {VertexBatchProvider} from '../supabase/functions/sub2api/vertex_batch_provider.ts';
import {VertexBatchClient} from '../supabase/functions/sub2api/vertex_batch.ts';
import {VertexBatchStorage} from '../supabase/functions/sub2api/vertex_gcs.ts';
const name='projects/project-1/locations/global/batchPredictionJobs/123';
test('Vertex provider separates durable upload checkpoint from native creation and streams actual result shards',async()=>{
 const seen=[];const fetcher=async(url,init)=>{
  seen.push([String(url),init.method]);if(String(url).includes('/upload/')){const line=JSON.parse(new TextDecoder().decode(init.body));assert.equal(line.request.contents[0].role,'user');return Response.json({});}
  if(String(url).includes('batchPredictionJobs'))return Response.json({name,state:init.method==='POST'?'JOB_STATE_QUEUED':'JOB_STATE_SUCCEEDED'});
  if(String(url).includes('alt=media'))return new Response('{"key":"cover","response":{}}');
  if(init.method==='DELETE')return new Response(null,{status:204});
  return Response.json({items:[{name:'batch-image/production/imgbatch_abc/output/predictions.jsonl'}]});
 };
 const token=async()=>'token',storage=new VertexBatchStorage('batch-bucket','imgbatch_abc',token,fetcher),provider=new VertexBatchProvider(new VertexBatchClient('project-1','global',token,fetcher),storage),signal=AbortSignal.timeout(5000);
 const checkpoint=await provider.uploadInput({model:'gemini-image',items:[{custom_id:'cover',prompt:'blue square'}]},signal);assert.equal(seen.length,1);assert.equal(checkpoint.input_ref,storage.inputURI);
 assert.equal((await provider.createUploadedBatch('gemini-image','images',checkpoint,signal)).status,'queued');assert.equal((await provider.getBatch(name,signal)).status,'succeeded');
 let result='';for await(const chunk of provider.resultChunks(signal))result+=new TextDecoder().decode(chunk);assert.equal(JSON.parse(result).key,'cover');await provider.deleteInput(signal);await provider.deleteOutputs(signal);assert.equal(seen.filter(([,method])=>method==='POST').length,2);
});
test('Vertex provider rejects mismatched persisted checkpoints before any create call',async()=>{
 const token=async()=>'token',fetcher=()=>assert.fail('invalid checkpoint reached network'),storage=new VertexBatchStorage('batch-bucket','imgbatch_abc',token,fetcher),provider=new VertexBatchProvider(new VertexBatchClient('project-1','global',token,fetcher),storage);
 await assert.rejects(provider.createUploadedBatch('gemini-image','images',{input_ref:'gs://other/input',output_ref:storage.outputURI},AbortSignal.timeout(5000)),/checkpoint_mismatch/);
});
test('Vertex provider rejects returned output prefixes belonging to other jobs',async()=>{
 const token=async()=>'token',fetcher=async()=>Response.json({name,state:'JOB_STATE_SUCCEEDED',outputConfig:{gcsDestination:{outputUriPrefix:'gs://batch-bucket/other/output/'}}}),storage=new VertexBatchStorage('batch-bucket','imgbatch_abc',token,fetcher),provider=new VertexBatchProvider(new VertexBatchClient('project-1','global',token,fetcher),storage);
 await assert.rejects(provider.getBatch(name,AbortSignal.timeout(5000)),/output_mismatch/);
});
