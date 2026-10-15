import test from 'node:test';
import assert from 'node:assert/strict';
import {readBody} from '../supabase/functions/sub2api/validation.ts';
import {resolveRequestLimits,requestBodyLimit,requestLimitSecrets} from '../supabase/functions/sub2api/request_limits.ts';
const request=(body,headers={})=>new Request('https://example.com/v1/responses',{method:'POST',body,headers,...(body instanceof ReadableStream?{duplex:'half'}:{})});
test('large JSON bodies exceed the previous cap without changing content',async()=>{
 const value={text:'x'.repeat(1024*1024+32)};
 assert.deepEqual(await readBody(request(JSON.stringify(value))),value);
});
test('streaming byte limits preserve split Unicode and reject actual overflow',async()=>{
 const value={text:'中文😀'},bytes=new TextEncoder().encode(JSON.stringify(value));
 const stream=()=>new ReadableStream({start(c){for(const byte of bytes)c.enqueue(Uint8Array.of(byte));c.close();}});
 assert.deepEqual(await readBody(request(stream()),bytes.length),value);
 await assert.rejects(readBody(request(stream(),{'content-length':'1'}),bytes.length-1),e=>e.status===413);
 let cancelled=false;
 const pending=new ReadableStream({cancel(){cancelled=true;}});
 await assert.rejects(readBody(request(pending,{'content-length':'100'}),10),e=>e.status===413);
 assert.equal(cancelled,true);
});
test('configuration matches upstream defaults and layered limits',()=>{
 const limits=resolveRequestLimits({});
 assert.equal(requestBodyLimit('/v1/responses',limits),256*1024*1024);
 assert.equal(requestBodyLimit('/v1/embeddings',limits),32*1024*1024);
 for(const path of ['/v1/alpha/search','/alpha/search','/backend-api/codex/alpha/search'])assert.equal(requestBodyLimit(path,limits),limits.text);
 assert.equal(requestBodyLimit('/v1/chat/completions',limits),limits.gateway);
 assert.equal(requestBodyLimit('/v1/messages',{server:10,gateway:20,text:5}),10);
 assert.equal(requestBodyLimit('/v1/messages',{server:0,gateway:20,text:5}),20);
 assert.match(requestLimitSecrets({}),/GATEWAY_MAX_BODY_SIZE=268435456\n/);
 for(const value of ['-1','Infinity','1.5','9007199254740992','1\nOTHER=2'])assert.throws(()=>resolveRequestLimits({GATEWAY_MAX_BODY_SIZE:value}));
 assert.throws(()=>resolveRequestLimits({GATEWAY_MAX_BODY_SIZE:'0'}));
 assert.throws(()=>resolveRequestLimits({GATEWAY_MAX_BODY_SIZE:'10'}));
 assert.equal(resolveRequestLimits({SERVER_MAX_REQUEST_BODY_SIZE:'0'}).server,0);
});
