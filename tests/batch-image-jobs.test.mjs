import {createHmac} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackendHandler} from './handler.mjs';
const config={url:'https://project.supabase.co',serviceKey:'private-service',jobSigningKey:'a'.repeat(64),adminIds:[],dataModel:'native'};
test('batch worker authenticates scoped short-lived tickets before accessing queues',async()=>{
 const now=Math.floor(Date.now()/1000),nonce=crypto.randomUUID(),calls=[];
 const ticket=(expiry,scope='batch-images',key=config.jobSigningKey)=>`${expiry}:${nonce}:${createHmac('sha256',key).update(`s2a-${scope}:${expiry}:${nonce}`).digest('hex')}`;
 const handler=createBackendHandler(config,async(url)=>{calls.push(String(url).split('/').at(-1));return Response.json([]);});
 const request=(value,method='POST')=>new Request('https://gateway/internal/jobs/batch-images',{method,headers:{'x-s2a-batch-images-job-token':value}});
 for(const value of ['',ticket(now-1),ticket(now+100),ticket(now+60,'images'),ticket(now+60,'batch-images',config.serviceKey)])assert.equal((await handler(request(value))).status,401);
 assert.deepEqual(calls,[]);
 assert.equal((await handler(request(ticket(now+60),'GET'))).status,405);assert.deepEqual(calls,[]);
 const response=await handler(request(ticket(now+60)));assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{claimed:0,processed:0,cleaned:0});
 assert.deepEqual(calls.sort(),['s2a_batch_image_cleanup_claim','s2a_batch_image_runtime_claim']);
});
test('batch worker acknowledges Edge background work and waits for both queues',async()=>{
 const pending=[],calls=[];
 const previous=globalThis.EdgeRuntime;
 globalThis.EdgeRuntime={waitUntil(promise){pending.push(promise);}};
 try{
  const handler=createBackendHandler(config,async(url)=>{calls.push(String(url).split('/').at(-1));return Response.json([]);});
  const response=await handler(new Request('https://gateway/internal/jobs/batch-images',{method:'POST',headers:{authorization:'Bearer '+config.serviceKey}}));
  assert.equal(response.status,202);assert.deepEqual(await response.json(),{accepted:true});
  assert.equal(pending.length,2);await Promise.all(pending);assert.ok(calls.includes('s2a_batch_image_runtime_claim'));assert.ok(calls.includes('s2a_batch_image_cleanup_claim'));
 }finally{if(previous===undefined)delete globalThis.EdgeRuntime;else globalThis.EdgeRuntime=previous;}
});
