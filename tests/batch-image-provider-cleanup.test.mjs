import test from 'node:test';
import assert from 'node:assert/strict';
import {Database} from '../supabase/functions/sub2api/db.ts';
import {batchProviderCleanup} from '../supabase/functions/sub2api/batch_image_provider_cleanup.ts';
const job={batch_id:'imgbatch_'+'a'.repeat(32),account_id:'1',provider:'gemini_api',input_ref:'files/input',output_ref:'files/output'},signal=()=>AbortSignal.timeout(5000);
test('Gemini cleanup reads pinned account credentials and idempotently deletes both remote files',async()=>{
 const calls=[],db=new Database({url:'https://db.invalid',serviceKey:'service'},async(url,init)=>{calls.push(String(url));if(String(url).includes('/rpc/')){assert.equal(JSON.parse(init.body).p_id,'1');return Response.json({id:'1',type:'apikey',platform:'gemini',credential_storage:'vault',credentials:{api_key:'provider-token'}});}assert.equal(init.method,'DELETE');assert.equal(new Headers(init.headers).get('x-goog-api-key'),'provider-token');return new Response(null,{status:404});});
 await batchProviderCleanup(db)(job,signal());assert.equal(calls.length,3);assert.ok(calls[1].endsWith('/files/input'));assert.ok(calls[2].endsWith('/files/output'));
});
test('cleanup skips never-uploaded Gemini tasks and rejects mismatched accounts or resources',async()=>{
 const untouched=new Database({url:'https://db.invalid',serviceKey:'service'},()=>assert.fail('empty cleanup reached network'));await batchProviderCleanup(untouched)({...job,input_ref:null,output_ref:'gemini:pending'},signal());
 for(const mismatch of [true,false]){let providerCalls=0;const db=new Database({url:'https://db.invalid',serviceKey:'service'},async(url)=>{if(!String(url).includes('/rpc/'))providerCalls++;return Response.json({id:mismatch?'2':'1',type:'apikey',platform:'gemini',credential_storage:'vault',credentials:{api_key:'provider-token'}});});await assert.rejects(batchProviderCleanup(db)({...job,input_ref:'https://evil.example/private',output_ref:null},signal()));assert.equal(providerCalls,0);}
});
