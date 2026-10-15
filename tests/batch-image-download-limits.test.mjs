import test from 'node:test';
import assert from 'node:assert/strict';
import {limitedBatchDownload} from '../supabase/functions/sub2api/batch_image_download_limits.ts';
const signal=()=>AbortSignal.timeout(5000);
test('batch ZIP byte cap includes archive framing and cancels oversized input',async()=>{
 let cancelled=false;const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(3));c.enqueue(new Uint8Array(3));},cancel(){cancelled=true;}});
 const reader=limitedBatchDownload(stream,signal(),5).getReader();assert.equal((await reader.read()).value.length,3);await assert.rejects(reader.read(),/batch_image_download_too_large/);assert.equal(cancelled,true);
});
test('batch downloads accept exact byte limit and propagate request cancellation',async()=>{
 const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(5));c.close();}});assert.equal((await new Response(limitedBatchDownload(stream,signal(),5)).arrayBuffer()).byteLength,5);
 const abort=new AbortController();abort.abort(Error('download cancelled'));
 await assert.rejects(new Response(limitedBatchDownload(new ReadableStream(),abort.signal,5)).arrayBuffer(),/download cancelled/);
});
