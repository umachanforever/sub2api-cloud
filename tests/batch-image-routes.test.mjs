import test from 'node:test';
import assert from 'node:assert/strict';
import {Database} from '../supabase/functions/sub2api/db.ts';
import {batchImageRoute} from '../supabase/functions/sub2api/batch_image_routes.ts';
const id='imgbatch_'+'a'.repeat(32);
test('batch routes share hashed key authentication for reads, pagination and mutations',async()=>{
 const seen=[],db=new Database({url:'https://db.invalid',serviceKey:'service',dataModel:'native'},async(url,init)=>{const args=JSON.parse(init.body);seen.push([String(url).split('/').at(-1),args]);assert.match(args.p_key_hash,/^[a-f0-9]{64}$/);assert.ok(!init.body.includes('client-secret'));return Response.json({id,items:[{custom_id:'ok',status:'success'},{custom_id:'bad',status:'failed'}]});});
 for(const [path,method,rpc] of [['/images/batches','GET','list'],[`/v1/images/batches/${id}`,'GET','read'],[`/v1/images/batches/${id}/cancel`,'POST','cancel'],[`/v1/images/batches/${id}/outputs`,'DELETE','delete'],[`/v1/images/batches/${id}`,'DELETE','delete']]){assert.equal((await batchImageRoute(new Request('https://gateway.invalid'+path,{method}),path,'client-secret',db)).status,200);assert.equal(seen.at(-1)[0],'s2a_batch_image_'+rpc);}
 const path=`/v1/images/batches/${id}/items`,response=await batchImageRoute(new Request('https://gateway.invalid'+path+'?status=failed'),path,'client-secret',db);assert.equal((await response.json()).data[0].custom_id,'bad');
});
test('batch routes reject missing credentials and invalid pagination or methods before mutation',async()=>{
 const db=new Database({url:'https://db.invalid',serviceKey:'service',dataModel:'native'},()=>assert.fail('invalid route reached database'));
 await assert.rejects(batchImageRoute(new Request('https://gateway.invalid/images/batches'),'/images/batches','',db),error=>error.status===401);
 await assert.rejects(batchImageRoute(new Request('https://gateway.invalid/images/batches?limit=-1'),'/images/batches','key',db),error=>error.status===400);
 await assert.rejects(batchImageRoute(new Request('https://gateway.invalid/images/batches',{method:'PATCH'}),'/images/batches','key',db),error=>error.status===405);
});
test('HTTP idempotency keys retain the same batch and avoid duplicate storage on retry',async()=>{
 const jobs=new Map();let uploads=0;const db=new Database({url:'https://db.invalid',serviceKey:'service',dataModel:'native'},async(url,init)=>{
  if(!String(url).includes('/rpc/')){uploads++;return Response.json({});}
  const name=String(url).split('/').at(-1),args=JSON.parse(init.body),saved=jobs.get(args.p_id);
  if(name.endsWith('_read'))return Response.json(saved?{id:args.p_id,task_name:saved.task_name,items:[]}:{error:'batch_image_not_found',status:404});
  if(name.endsWith('_prepare')){if(!saved)jobs.set(args.p_id,{task_name:args.p_name,ready:false});return Response.json({id:args.p_id,ready:saved?.ready??false});}
  if(name.endsWith('_ready'))jobs.get(args.p_id).ready=true;return Response.json({id:args.p_id,ready:true});
 });
 const request=()=>new Request('https://gateway.invalid/v1/images/batches',{method:'POST',headers:{'idempotency-key':'client-request-1','content-type':'application/json'},body:JSON.stringify({model:'gemini-image',items:[{prompt:'blue square'}]})});
 const first=await (await batchImageRoute(request(),'/v1/images/batches','client-secret',db)).json(),second=await (await batchImageRoute(request(),'/v1/images/batches','client-secret',db)).json();assert.equal(first.id,second.id);assert.equal(jobs.size,1);assert.equal(uploads,1);
});

test('batch list forwards normalized filters and original numeric cursor',async()=>{
 const db=new Database({url:'https://db.invalid',serviceKey:'service',dataModel:'native'},async(url,init)=>{
  const args=JSON.parse(init.body);assert.equal(args.p_offset,40);
  assert.deepEqual(args.p_filters,{status:'queued',task_name:'sample',downloaded:false,from:'2026-01-01T00:00:00.000Z'});
  return Response.json({items:[],total:0});
 });
 await batchImageRoute(new Request('https://gateway.invalid/images/batches?cursor=40&status=queued&task_name=sample&downloaded=no&from=1767225600'),'/images/batches','key',db);
 for(const query of ['downloaded=maybe','from=invalid','cursor=-1'])await assert.rejects(batchImageRoute(new Request('https://gateway.invalid/images/batches?'+query),'/images/batches','key',db),error=>error.status===400);
});
