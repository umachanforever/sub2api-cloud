import test from 'node:test';
import assert from 'node:assert/strict';
import {vertexBatchConfig,batchImageSecrets} from '../supabase/functions/sub2api/batch_image_config.ts';
test('Vertex batch settings validate managed storage and regional endpoints before deployment',()=>{
 assert.equal(vertexBatchConfig({}),undefined);
 assert.deepEqual(vertexBatchConfig({SUB2API_VERTEX_BATCH_BUCKET:' images-bucket '}),{bucket:'images-bucket',location:'global',environment:'production'});
 const env={SUB2API_VERTEX_BATCH_BUCKET:'images-bucket',SUB2API_VERTEX_BATCH_LOCATION:'us-central1',SUB2API_VERTEX_BATCH_ENVIRONMENT:'staging'};
 assert.deepEqual(vertexBatchConfig(env),{bucket:'images-bucket',location:'us-central1',environment:'staging'});
 assert.match(batchImageSecrets(env),/SUB2API_VERTEX_BATCH_LOCATION=us-central1\n/);
 for(const invalid of [{SUB2API_VERTEX_BATCH_LOCATION:'global'},{SUB2API_VERTEX_BATCH_BUCKET:'gs://bucket'},{...env,SUB2API_VERTEX_BATCH_ENVIRONMENT:'../production'},{...env,SUB2API_VERTEX_BATCH_LOCATION:'global\nINJECTED=value'}])assert.throws(()=>vertexBatchConfig(invalid));
 assert.equal(batchImageSecrets({}),'SUB2API_VERTEX_BATCH_BUCKET=\nSUB2API_VERTEX_BATCH_LOCATION=\nSUB2API_VERTEX_BATCH_ENVIRONMENT=\n');
});
