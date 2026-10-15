import test from 'node:test';
import assert from 'node:assert/strict';
import {cacheCreateInput} from '../supabase/functions/sub2api/gemini_cache_create.ts';
import {createBackendHandler} from './handler.mjs';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';
const config={url:'https://database.invalid',serviceKey:'private',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
test('cache creation normalizes metadata and preserves content while removing output fields',()=>{
 const content={contents:[{parts:[{text:'context'}]}],model:'models/gemini-cache',display_name:'Name',name:'ignored',usage_metadata:{totalTokenCount:9}};
 const result=cacheCreateInput(content);assert.equal(result.model,'gemini-cache');assert.equal(result.seconds,3600);assert.equal(result.displayName,'Name');assert.deepEqual(result.body,{contents:content.contents});assert.equal(content.display_name,'Name');
 for(const input of [{model:'../escape'},{model:'gemini',ttl:'0s'},{model:'gemini',displayName:'x'.repeat(129)},{model:'gemini',displayName:'a',display_name:'b'},{model:'gemini',ttl:'1s',expireTime:'2099-01-01T00:00:00Z'}])assert.throws(()=>cacheCreateInput(input));
});
for(const scenario of ['success','retry-persist','malformed','network','failover'])test(`cache creation ${scenario} retains ownership and hides provider identity`,async()=>{
 const credentials=await encryptCredentials({api_key:'provider-key'},config.encryptionKey);const events=[],finishes=[];let publicId,acquires=0,completes=0,forwards=0;
 const expiry=new Date(Date.now()+3600000).toISOString();
 const handler=createBackendHandler(config,async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_key_policy'))return Response.json({platform:'gemini'});
  if(String(url).endsWith('/s2a_personal_acquire')){acquires++;const args=JSON.parse(init.body);assert.equal(args.p_billing_context.cache_create,true);assert.equal(args.p_count_request,acquires===1);if(acquires===2)assert.deepEqual(args.p_excluded,['1']);return Response.json({lease_id:'lease-'+acquires,account:{...credentials,id:String(acquires),platform:'gemini',credential_version:1},model_sources:{mapping:{'gemini-cache':'gemini-upstream'}}});}
  if(String(url).endsWith('/s2a_personal_cache_create')){
   const args=JSON.parse(init.body);events.push(args.p_action);assert.equal(args.p_upstream_model,'gemini-upstream');assert.equal(args.p_display_name,'Name');
   if(args.p_action==='prepare'){publicId=args.p_public_id;assert.match(publicId,/^[a-f0-9]{40}$/);return Response.json({prepared:true});}
   completes++;if(scenario==='retry-persist'&&completes===1)throw new TypeError('transient persistence');assert.equal(args.p_upstream_name,'cachedContents/private');assert.equal(args.p_token_count,100);return Response.json({created:true});
  }
  if(String(url).endsWith('/s2a_personal_cache_read'))return Response.json({name:'cachedContents/'+publicId,model:'models/gemini-cache',displayName:'Name',expireTime:expiry,usageMetadata:{totalTokenCount:100}});
  if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
  if(String(url).includes('/rpc/'))return Response.json(null);
  forwards++;events.push('provider');assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/cachedContents');const body=JSON.parse(init.body);assert.equal(body.model,'models/gemini-upstream');assert.equal(body.displayName,'s2a-'+publicId);assert.equal(body.ttl,'3600s');assert.deepEqual(body.contents,[{parts:[{text:'context'}]}]);
  if(scenario==='network')throw new TypeError('network');if(scenario==='failover'&&forwards===1)return Response.json({error:'quota'},{status:429});
  return Response.json({name:scenario==='malformed'?'https://wrong.invalid':'cachedContents/private',expireTime:expiry,usageMetadata:{totalTokenCount:100}});
 });
 const response=await handler(new Request('https://gateway/v1beta/cachedContents',{method:'POST',headers:{'x-goog-api-key':'sk-client','content-type':'application/json'},body:JSON.stringify({model:'gemini-cache',displayName:'Name',contents:[{parts:[{text:'context'}]}]})}));
 const success=!['malformed','network'].includes(scenario);assert.equal(response.status,success?200:502);assert.equal(acquires,scenario==='failover'?2:1);assert.equal(events[0],'prepare');assert.equal(finishes.at(-1).p_outcome,success?'completed':'failed');
 if(success){const body=await response.json();assert.equal(body.name,'cachedContents/'+publicId);assert.equal(body.displayName,'Name');assert.ok(!JSON.stringify(body).includes('private'));}
 if(scenario==='retry-persist')assert.equal(completes,2);if(!success)assert.equal(completes,0);
});
test('cache creation rejects non-Gemini groups before reading input or acquiring accounts',async()=>{
 let reads=0,acquired=0;const handler=createBackendHandler(config,async(url)=>{if(String(url).endsWith('/s2a_personal_key_policy'))return Response.json({platform:'openai'});if(String(url).endsWith('/s2a_personal_acquire'))acquired++;return Response.json(null);});
 const stream=new ReadableStream({pull(){reads++;}},{highWaterMark:0});const response=await handler(new Request('https://gateway/v1beta/cachedContents',{method:'POST',headers:{authorization:'Bearer sk-client'},body:stream,duplex:'half'}));assert.equal(response.status,400);assert.equal(reads,0);assert.equal(acquired,0);
});
