import test from 'node:test';
import assert from 'node:assert/strict';
import {withBatchDownloadPermit} from '../supabase/functions/sub2api/batch_image_download_permit.ts';
const lease='12345678-1234-1234-1234-123456789abc';
function fixture(){const calls=[];return {calls,db:{rpc:async(name,args)=>{calls.push([name,args]);return name.endsWith('acquire')?{lease_id:lease}:{released:true};}}};}
test('download permits reject concurrent requests before reading media',async()=>{
 await assert.rejects(withBatchDownloadPermit({rpc:async()=>({error:'batch_image_download_limited',status:429})},'hash','batch',null,new AbortController().signal,()=>assert.fail('media read')),error=>error.status===429);
});
test('download permit remains held until consumed and releases once',async()=>{
 const {calls,db}=fixture();const response=await withBatchDownloadPermit(db,'hash','batch',null,new AbortController().signal,async()=>new Response('media',{headers:{'content-type':'image/png'}}));
 assert.equal(calls.length,1);assert.equal(await response.text(),'media');assert.equal(response.headers.get('content-type'),'image/png');assert.equal(calls.length,2);assert.deepEqual(calls[1][1],{p_lease:lease});
});
test('download cancellation, source failure and setup failure release permits',async()=>{
 for(const mode of ['cancel','source','setup']){const {calls,db}=fixture();const create=async()=>{if(mode==='setup')throw Error('setup');return new Response(new ReadableStream({pull(c){if(mode==='source')c.error(Error('source'));else c.enqueue(new Uint8Array([1]));}}));};
 if(mode==='setup')await assert.rejects(withBatchDownloadPermit(db,'h','b',null,new AbortController().signal,create),/setup/);
 else{const response=await withBatchDownloadPermit(db,'h','b',null,new AbortController().signal,create);if(mode==='source')await assert.rejects(response.text(),/source/);else await response.body.cancel();}
 assert.equal(calls.filter(([name])=>name.endsWith('release')).length,1);
 }
});
test('aborted downloads release even when their response is never read',async()=>{
 const {calls,db}=fixture(),abort=new AbortController();const response=await withBatchDownloadPermit(db,'h','b',null,abort.signal,async()=>new Response('media'));
 abort.abort();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,2);await assert.rejects(response.text());assert.equal(calls.length,2);
});
