import test from 'node:test';
import assert from 'node:assert/strict';
import {cachePage} from '../supabase/functions/sub2api/gemini_cache_read.ts';
import {createBackendHandler} from './handler.mjs';
test('cache pagination validates native int64 cursors and page bounds',()=>{
 assert.deepEqual(cachePage(new URL('https://g/')),{size:50,before:null});
 assert.deepEqual(cachePage(new URL('https://g/?pageSize=1001&pageToken=OTIyMzM3MjAzNjg1NDc3NTgwNw')),{size:1000,before:'9223372036854775807'});
 for(const q of ['pageSize=-1','pageSize=1.5','pageToken=MA','pageToken=LTE','pageToken=OTIyMzM3MjAzNjg1NDc3NTgwOA','pageToken=MQ=='])assert.throws(()=>cachePage(new URL('https://g/?'+q)));
});
test('cache reads authenticate Gemini keys and do not acquire inference accounts',async()=>{
 const config={url:'https://database.invalid',serviceKey:'private',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
 let reads=0;
 const handler=createBackendHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_cache_read')){reads++;const body=JSON.parse(init.body);assert.equal(body.p_page_size,1);assert.equal(body.p_before,'2');assert.equal(body.p_name,null);return Response.json({cachedContents:[{name:'cachedContents/owned'}],nextPageToken:'MQ'});}
  assert.ok(!String(url).endsWith('/s2a_personal_acquire'));return Response.json(null);
 });
 const response=await handler(new Request('https://g/v1beta/cachedContents?pageSize=1&pageToken=Mg',{headers:{'x-goog-api-key':'sk-client'}}));
 assert.equal(response.status,200);assert.equal((await response.json()).cachedContents[0].name,'cachedContents/owned');assert.equal(reads,1);
 assert.equal((await handler(new Request('https://g/v1beta/cachedContents'))).status,401);
});
