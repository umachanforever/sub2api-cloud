import test from 'node:test';
import assert from 'node:assert/strict';
import {Database} from '../supabase/functions/sub2api/db.ts';
import {batchImageRoute} from '../supabase/functions/sub2api/batch_image_routes.ts';
test('batch model catalog expands configured mappings, filters allowlists and preserves provider identity',async()=>{
 const db=new Database({url:'https://db.invalid',serviceKey:'service',dataModel:'native'},async(url,init)=>{
  assert.ok(String(url).endsWith('s2a_batch_image_model_sources'));assert.equal(JSON.parse(init.body).p_vertex_enabled,false);
  return Response.json({sources:[{provider:'gemini_api',mapping:{'gemini-3*':'target','custom-image':'target'}},{provider:'gemini_api',mapping:{'custom-image':'other'}},{provider:'vertex',mapping:{'custom-image':'target'}}],model_allowlist:{enabled:true,models:['gemini-3.1-flash-image','custom-image']}});
 });
 const path='/images/batches/models',response=await batchImageRoute(new Request('https://gateway'+path),path,'secret',db);
 assert.deepEqual(await response.json(),{object:'list',data:[{id:'custom-image',object:'image.batch.model',provider:'gemini_api'},{id:'gemini-3.1-flash-image',object:'image.batch.model',provider:'gemini_api'},{id:'custom-image',object:'image.batch.model',provider:'vertex'}]});
});
test('batch models propagate denied group permission without returning account metadata',async()=>{
 const db=new Database({url:'https://db.invalid',serviceKey:'service',dataModel:'native'},async()=>Response.json({error:'batch_image_generation_forbidden',status:403}));
 await assert.rejects(batchImageRoute(new Request('https://gateway/images/batches/models'),'/images/batches/models','key',db),error=>error.status===403);
});
