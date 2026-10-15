import test from 'node:test';
import assert from 'node:assert/strict';
import {trackBatchDownload} from '../supabase/functions/sub2api/batch_image_downloaded.ts';
test('download tracking marks completed streams once and preserves headers and media',async()=>{
 const calls=[],db={rpc:async(name,args)=>{calls.push([name,args]);return {applied:true};}};
 const response=trackBatchDownload(new Response('media',{headers:{'content-type':'image/png'}}),db,'hash','batch','127.0.0.1');
 assert.equal(response.headers.get('content-type'),'image/png');assert.equal(await response.text(),'media');assert.equal(calls.length,1);assert.equal(calls[0][1].p_client_ip,'127.0.0.1');
});
test('cancelled and failed downloads never mark the batch downloaded',async()=>{
 for(const failed of [false,true]){
  let cancelled=false;const stream=new ReadableStream({pull(controller){if(failed)controller.error(Error('media failed'));else controller.enqueue(new Uint8Array([1]));},cancel(){cancelled=true;}});
  const response=trackBatchDownload(new Response(stream),{rpc:()=>assert.fail('partial download marked')},'hash','batch',null);
  if(failed)await assert.rejects(response.arrayBuffer(),/media failed/);else{await response.body.cancel();assert.equal(cancelled,true);}
 }
});
test('download checkpoint failure does not corrupt a completed media response',async()=>{
 const response=trackBatchDownload(new Response('media'),{rpc:async()=>{throw Error('database down');}},'hash','batch',null);assert.equal(await response.text(),'media');
});
