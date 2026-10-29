import test from 'node:test';
import assert from 'node:assert/strict';
import {keepRequestLease,REQUEST_TIMEOUT_MS} from '../supabase/functions/sub2api/request_lease.ts';
const pause=()=>new Promise(resolve=>setTimeout(resolve,20));
test('active requests renew; finishing and cancellation stop renewal',async()=>{
 let calls=0;const db={rpc:async(name,args)=>{assert.equal(name,'s2a_personal_lease_renew');assert.equal(args.p_lease_id,'lease');calls++;return true;}};
 const controller=new AbortController(),failed=new AbortController();
 const stop=keepRequestLease(db,'lease',controller.signal,failed,2);
 await pause();assert.ok(calls>0);stop();const before=calls;await pause();assert.equal(calls,before);assert.equal(failed.signal.aborted,false);
 keepRequestLease(db,'lease',controller.signal,failed,2);controller.abort();await pause();assert.equal(calls,before);
 assert.ok(REQUEST_TIMEOUT_MS>15*60*1000);
});
test('expired leases and database failure abort the request',async()=>{
 for(const rpc of [async()=>false,async()=>{throw Error('offline');}]){
  const failed=new AbortController();const stop=keepRequestLease({rpc},'lease',failed.signal,failed,2);
  await pause();assert.equal(failed.signal.aborted,true);stop();
 }
});
