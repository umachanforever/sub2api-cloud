import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyIndependence} from '../scripts/verify-independence.mjs';
const config={base_url:'https://project.supabase.co/functions/v1/sub2api/v1',api_key:'sk-test',model:'test'};
function fixture({foreign=false,stopFails=false,restoreFails=false}={}) {
 const calls=[];
 return {calls,run:async args=>{
  calls.push(args);
  if(args[0]==='inspect')return JSON.stringify([{Name:'/'+args[1],Config:{Labels:{'com.docker.compose.project':foreign?'other-project':'sub2api-cloud'}},State:{Running:!args[1].endsWith('redis')}}]);
  if(stopFails && args[0]==='stop')throw Error('stop failed');
  if(restoreFails && args[0]==='start' && args[1].endsWith('management'))throw Error('restore failed');
  return '';
 }};
}
test('independence verification stops only running owned containers and restores them after a failed cloud check',async()=>{
 const {run,calls}=fixture();
 await assert.rejects(verifyIndependence(config,run,async()=>{
  assert.equal(calls.filter(x=>x[0]==='stop').length,2);
  throw Error('cloud failed');
 }),/cloud failed/);
 assert.deepEqual(calls.filter(x=>x[0]==='start').map(x=>x[1]),['sub2api-cloud-management','sub2api-cloud-console']);
 assert.ok(!calls.some(x=>x[0]==='stop' && x.at(-1).endsWith('redis')));
});
test('independence verification validates cloud destination and container ownership before mutations',async()=>{
 const {run,calls}=fixture({foreign:true});
 await assert.rejects(verifyIndependence({...config,base_url:'http://localhost/v1'},run),/Configure a cloud/);
 assert.equal(calls.length,0);
 await assert.rejects(verifyIndependence(config,run),/ownership/);
 assert.ok(calls.every(x=>x[0]==='inspect'));
});
test('independence verification recovers a failed stop and attempts every restore',async()=>{
 const stopped=fixture({stopFails:true});
 await assert.rejects(verifyIndependence(config,stopped.run),/stop failed/);
 assert.equal(stopped.calls.at(-1)[0],'start');
 const restored=fixture({restoreFails:true});
 await assert.rejects(verifyIndependence(config,restored.run,async()=>['health']),/Restore these local containers/);
 assert.equal(restored.calls.filter(x=>x[0]==='start').length,2);
});
