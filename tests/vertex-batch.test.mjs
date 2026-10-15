import test from 'node:test';
import assert from 'node:assert/strict';
import {vertexBatchEndpoint,vertexBatchResource,vertexBatchManagedRefs,buildVertexBatchJSONL,vertexBatchCreateRequest,vertexBatchStatus} from '../supabase/functions/sub2api/vertex_batch.ts';
const name='projects/project-1/locations/global/batchPredictionJobs/123';
test('Vertex native batch protocol uses regional endpoints, keyed JSONL and managed GCS',()=>{
 assert.equal(vertexBatchEndpoint('project-1'),'https://aiplatform.googleapis.com/v1/projects/project-1/locations/global/batchPredictionJobs');
 assert.match(vertexBatchEndpoint('project-1','us-central1'),/^https:\/\/us-central1-aiplatform/);
 const refs=vertexBatchManagedRefs('batch-bucket','imgbatch_abc');
 const request=vertexBatchCreateRequest('gemini-3-pro-image-preview',refs.input,refs.output,'My images');
 assert.equal(request.model,'publishers/google/models/gemini-3-pro-image-preview');assert.deepEqual(request.instanceConfig,{keyField:'key'});assert.deepEqual(request.inputConfig.gcsSource.uris,[refs.input]);
 const line=JSON.parse(new TextDecoder().decode(buildVertexBatchJSONL({model:'gemini-image',items:[{custom_id:'cover',prompt:'blue square',reference_images:[{mime_type:'image/png',file_uri:'gs://batch-bucket/reference.png'}]}]})));
 assert.equal(line.key,'cover');assert.equal(line.request.contents[0].role,'user');assert.equal(line.request.contents[0].parts[1].fileData.fileUri,'gs://batch-bucket/reference.png');assert.deepEqual(line.request.generationConfig.responseModalities,['TEXT','IMAGE']);
});
test('Vertex batch paths cannot inject hosts, resources or cleanup prefixes',()=>{
 for(const project of ['../x','x/locations/y','x?key=secret'])assert.throws(()=>vertexBatchEndpoint(project));
 for(const location of ['evil.example/path','../global'])assert.throws(()=>vertexBatchEndpoint('project',location));
 for(const value of ['https://evil.example/'+name,name+'/../other',name+'?key=secret'])assert.throws(()=>vertexBatchResource(value));
 for(const bucket of ['bucket/path','bucket?query','https://evil.example'])assert.throws(()=>vertexBatchManagedRefs(bucket,'imgbatch_abc'));
 assert.throws(()=>vertexBatchManagedRefs('bucket','../other'));
 assert.throws(()=>vertexBatchCreateRequest('../model','gs://bucket/input','gs://bucket/output/','display'));
 assert.throws(()=>vertexBatchCreateRequest('gemini-image','gs://bucket/../input','gs://bucket/output/','display'));
});
test('Vertex batch states retain safe codes and require a result reference for success',()=>{
 for(const [state,status] of [['PENDING','queued'],['QUEUED','queued'],['RUNNING','running'],['PAUSED','running'],['SUCCEEDED','succeeded'],['FAILED','failed'],['CANCELLED','cancelled'],['EXPIRED','expired']]){
  const result=vertexBatchStatus({name,state:'JOB_STATE_'+state},'gs://bucket/output/');assert.equal(result.status,status);assert.equal(result.done,!['queued','running'].includes(status));assert.equal(result.requeue_after_seconds,result.done?0:30);
 }
 assert.equal(vertexBatchStatus({name,state:'JOB_STATE_SUCCEEDED'}).error_code,'VERTEX_RESULT_OBJECTS_MISSING');
 const result=vertexBatchStatus({name,state:'UNKNOWN',error:{status:'PERMISSION_DENIED',message:'secret upstream detail'}});assert.equal(result.status,'failed');assert.equal(result.error_code,'PERMISSION_DENIED');assert.ok(!JSON.stringify(result).includes('secret'));
 assert.equal(vertexBatchStatus({name,state:'JOB_STATE_FAILED',error:{status:'secret value'}}).error_code,'VERTEX_BATCH_FAILED');
 assert.equal(vertexBatchStatus({name,state:'JOB_STATE_SUCCEEDED',outputConfig:{gcsDestination:{outputUriPrefix:'gs://bucket/results/'}}}).output_ref,'gs://bucket/results/');
 for(const value of [{name,state:[]},{name,outputConfig:[]},{name,error:[]},{name,outputConfig:{gcsDestination:{outputUriPrefix:'https://evil.example/'}}}])assert.throws(()=>vertexBatchStatus(value));
});
