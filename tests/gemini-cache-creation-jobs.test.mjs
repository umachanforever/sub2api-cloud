import test from 'node:test';
import assert from 'node:assert/strict';
import {Database} from '../supabase/functions/sub2api/db.ts';
import {cleanupCacheCreation} from '../supabase/functions/sub2api/gemini_cache_creation_jobs.ts';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
const config={url:'https://database.invalid',serviceKey:'private',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
for(const scenario of ['matched','pages','invalid-cursor','list-failure','delete-failure'])test(`creation cleanup ${scenario} deletes only its owning intent tag and persists bounded progress`,async()=>{
 const credentials=await encryptCredentials({api_key:'provider-key'},config.encryptionKey),id='a'.repeat(40);let lists=0,deleted=0;const finishes=[];
 const db=new Database(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_cache_creations_finish')){finishes.push(JSON.parse(init.body));return Response.json(true);}
  const headers=new Headers(init.headers);assert.equal(headers.get('x-goog-api-key'),'provider-key');assert.equal(new URL(url).origin,'https://generativelanguage.googleapis.com');
  if(init.method==='DELETE'){deleted++;assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/cachedContents/ours');return new Response(null,{status:scenario==='delete-failure'?503:204});}
  lists++;assert.equal(new URL(url).pathname,'/v1beta/cachedContents');assert.equal(new URL(url).searchParams.get('pageSize'),'20');
  if(scenario==='list-failure')return Response.json({error:'unavailable'},{status:503});
  if(scenario==='invalid-cursor')return Response.json({error:'bad cursor'},{status:400});
  if(scenario==='pages')return Response.json({cachedContents:[],nextPageToken:'page-'+lists});
  if(lists>1){assert.equal(new URL(url).searchParams.has('pageToken'),false);return Response.json({});}
  return Response.json({cachedContents:[{name:'cachedContents/foreign',model:'models/gemini-upstream',displayName:'s2a-'+('b'.repeat(40))},{name:'cachedContents/wrong-model',model:'models/other-model',displayName:'s2a-'+id},{name:'cachedContents/ours',model:'models/gemini-upstream',displayName:'s2a-'+id}],nextPageToken:'offset-after-delete'});
 });
 const handled=await cleanupCacheCreation(db,{public_id:id,lease_id:'lease',upstream_model:'gemini-upstream',page_token:scenario==='invalid-cursor'?'expired-cursor':null,account:{...credentials,id:'1',platform:'gemini',credential_version:1}},new Request('https://gateway/internal/jobs/gemini-cache',{method:'POST'}));
 const failed=['list-failure','delete-failure'].includes(scenario);assert.equal(handled,!failed);assert.equal(finishes.length,failed?0:1);assert.equal(deleted,['matched','delete-failure'].includes(scenario)?1:0);
 if(!failed){assert.equal(finishes[0].p_public_id,id);assert.equal(finishes[0].p_lease_id,'lease');assert.equal(finishes[0].p_complete,scenario==='matched');assert.equal(finishes[0].p_page_token,scenario==='pages'?'page-5':null);}
 if(scenario==='pages')assert.equal(lists,5);if(scenario==='matched')assert.equal(lists,2);
});
