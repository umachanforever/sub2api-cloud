import test from 'node:test';
import assert from 'node:assert/strict';
import {VertexBatchStorage} from '../supabase/functions/sub2api/vertex_gcs.ts';
const signal=()=>AbortSignal.timeout(5000),prefix='batch-image/production/imgbatch_owned/output/';
test('GCS upload, paginated sorted output discovery and streamed reads use task-bound official URLs',async()=>{
 const calls=[];const storage=new VertexBatchStorage('batch-bucket','imgbatch_owned',async()=>'private-token',async(url,init)=>{
  calls.push(String(url));const parsed=new URL(url);assert.equal(parsed.origin,'https://storage.googleapis.com');assert.equal(new Headers(init.headers).get('authorization'),'Bearer private-token');assert.equal(init.redirect,'error');
  if(init.method==='POST'){assert.equal(parsed.searchParams.get('name'),'batch-image/production/imgbatch_owned/input/requests.jsonl');assert.equal(new TextDecoder().decode(init.body),'{}\n');return Response.json({});}
  if(parsed.searchParams.get('alt')==='media')return new Response('result-stream');
  assert.equal(parsed.searchParams.get('prefix'),prefix);
  if(!parsed.searchParams.has('pageToken'))return Response.json({items:[{name:prefix+'z.jsonl'},{name:prefix+'other.txt'}],nextPageToken:'page-two'});
  return Response.json({items:[{name:prefix+'a.jsonl'},{name:prefix+'z.jsonl'}]});
 });
 assert.equal(await storage.uploadInput(new TextEncoder().encode('{}\n'),signal()),storage.inputURI);assert.deepEqual(await storage.listOutputs(signal()),['gs://batch-bucket/'+prefix+'a.jsonl','gs://batch-bucket/'+prefix+'z.jsonl']);assert.equal(await (await storage.openOutput('gs://batch-bucket/'+prefix+'a.jsonl',signal())).text(),'result-stream');assert.equal(calls.length,4);assert.equal(JSON.stringify(storage),'{}');
});
test('GCS rejects unrelated reads and deletes before requesting credentials',async()=>{
 const storage=new VertexBatchStorage('batch-bucket','imgbatch_owned',()=>assert.fail('unsafe path requested token'));
 for(const uri of ['gs://other/'+prefix+'x','gs://batch-bucket/'+prefix+'../x','gs://batch-bucket/batch-image/production/imgbatch_other/output/x','https://evil.example/x',storage.outputURI]){await assert.rejects(storage.openOutput(uri,signal()));await assert.rejects(storage.deleteObject(uri,signal()));}
 await assert.rejects(storage.openOutput(storage.inputURI,signal()));
});
test('GCS cleanup includes non-JSONL files and treats missing objects as deleted',async()=>{
 const deleted=[];const storage=new VertexBatchStorage('batch-bucket','imgbatch_owned',async()=>'token',async(url,init)=>{if(init.method==='GET')return Response.json({items:[{name:prefix+'predictions.jsonl'},{name:prefix+'metadata.json'}]});deleted.push(decodeURIComponent(new URL(url).pathname.split('/o/')[1]));return new Response(null,{status:404});});
 await storage.deleteOutputs(signal());await storage.deleteObject(storage.inputURI,signal());assert.equal(deleted.length,3);assert.ok(deleted.includes(prefix+'metadata.json'));
});
test('GCS rejects escaped provider listing and repeated page tokens',async()=>{
 for(const mode of ['outside','loop','oversize']){
  const storage=new VertexBatchStorage('batch-bucket','imgbatch_owned',async()=>'token',async()=>mode==='outside'?Response.json({items:[{name:'unrelated/private.jsonl'}]}):mode==='loop'?Response.json({nextPageToken:'same'}):new Response('x'.repeat(1024*1024+1)));
  await assert.rejects(storage.listOutputs(signal()));
 }
});
test('GCS combines result shards lazily with line boundaries and releases interrupted reads',async()=>{
 let opened=0,cancelled=0;const storage=new VertexBatchStorage('batch-bucket','imgbatch_owned',async()=>'token',async(url)=>{
  if(!String(url).includes('alt=media'))return Response.json({items:[{name:prefix+'b.jsonl'},{name:prefix+'a.jsonl'}]});
  opened++;return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('shard-'+opened));},cancel(){cancelled++;}}));
 });
 const iterator=storage.resultChunks(signal());assert.equal(new TextDecoder().decode((await iterator.next()).value),'shard-1');assert.equal(opened,1);await iterator.return();assert.equal(cancelled,1);assert.equal(opened,1);
 const complete=new VertexBatchStorage('batch-bucket','imgbatch_owned',async()=>'token',async(url)=>!String(url).includes('alt=media')?Response.json({items:[{name:prefix+'b.jsonl'},{name:prefix+'a.jsonl'}]}):new Response(String(url).includes('a.jsonl')?'a':'b'));
 let result='';for await(const chunk of complete.resultChunks(signal()))result+=new TextDecoder().decode(chunk);assert.equal(result,'a\nb');
});
