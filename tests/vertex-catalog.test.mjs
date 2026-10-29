import test from 'node:test';
import {GEMINI_FALLBACK_IDS} from '../supabase/functions/sub2api/gemini_catalog.ts';
import assert from 'node:assert/strict';
import {vertexCatalogLocation,vertexGeminiCatalog} from '../supabase/functions/sub2api/vertex_catalog.ts';
import {createBackendHandler} from './handler.mjs';
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const exported=Buffer.from(await crypto.subtle.exportKey('pkcs8',pair.privateKey)).toString('base64');
const credentials={service_account:{project_id:'project-1',client_email:'svc@project-1.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----\n'+exported+'\n-----END PRIVATE KEY-----'},location:'global'};
const signal=()=>AbortSignal.timeout(5000);
test('Vertex catalog location follows original default, legacy and per-model precedence',()=>{
 assert.equal(vertexCatalogLocation({}),'us-central1');
 assert.equal(vertexCatalogLocation({vertex_location:' europe-west1 '}),'europe-west1');
 assert.equal(vertexCatalogLocation({location:'global',vertex_location:'us-central1'}),'global');
 assert.equal(vertexCatalogLocation({location:'global',vertex_model_locations:{'gemini-special':'us-east1'}},'gemini-special'),'us-east1');
 for(const location of ['evil.example','global/path','global?key=x','../global','UPPER'])assert.throws(()=>vertexCatalogLocation({location}),{status:400});
});
test('Vertex publisher catalog collects pages, filters non-Gemini entries and deduplicates',async()=>{
 const seen=[];
 const result=await vertexGeminiCatalog(credentials,'/v1beta/models',async(url,init)=>{
  seen.push(String(url));assert.equal(init.redirect,'error');
  if(String(url)==='https://oauth2.googleapis.com/token')return Response.json({access_token:'private-token',expires_in:3600});
  const target=new URL(url);assert.equal(target.origin,'https://aiplatform.googleapis.com');assert.equal(target.pathname,'/v1beta1/publishers/google/models');assert.equal(target.searchParams.get('pageSize'),'300');assert.equal(new Headers(init.headers).get('authorization'),'Bearer private-token');
  return target.searchParams.has('pageToken')?Response.json({publisherModels:[{name:'publishers/google/models/gemini-a'},{name:'publishers/google/models/gemini-z'}]}):Response.json({publisherModels:[{name:'publishers/google/models/gemini-z'},{name:'publishers/google/models/gemma-3'},{name:'publishers/other/models/gemini-wrong'}],nextPageToken:'opaque?token'});
 },signal());
 assert.equal(seen.length,3);assert.equal(new URL(seen[2]).searchParams.get('pageToken'),'opaque?token');assert.deepEqual((await result.json()).models.map(model=>model.name),['models/gemini-a','models/gemini-z']);
});
test('Vertex details use per-model regions and missing models remain 404',async()=>{
 for(const model of ['gemini-known','gemini-unknown']){
  const result=await vertexGeminiCatalog({...credentials,vertex_model_locations:{[model]:'us-east1'}},'/v1beta/models/'+model,async(url)=>{
   if(String(url)==='https://oauth2.googleapis.com/token')return Response.json({access_token:'token',expires_in:3600});
   assert.equal(new URL(url).hostname,'us-east1-aiplatform.googleapis.com');return Response.json({publisherModels:[{name:'publishers/google/models/gemini-known'}]});
  },signal());assert.equal(result.status,model==='gemini-known'?200:404);
 }
});
test('Vertex API Key catalogs use the original fallback without token exchange',async()=>{
 const fetcher=async()=>{assert.fail('static catalog performed provider I/O');};
 const listed=await vertexGeminiCatalog({auth_mode:' apikey '},'/v1beta/models',fetcher,signal());assert.equal((await listed.json()).models.length,GEMINI_FALLBACK_IDS.length);
 const detail=await vertexGeminiCatalog({auth_mode:'apikey'},'/v1beta/models/gemini-future',fetcher,signal());assert.equal((await detail.json()).name,'models/gemini-future');
});
test('Vertex catalog enforces pagination and rejects malformed or empty provider responses',async()=>{
 for(const value of [{publisherModels:[]},{publisherModels:[null]},{publisherModels:[{name:42}]},{publisherModels:[],nextPageToken:42}]){
  await assert.rejects(vertexGeminiCatalog(credentials,'/v1beta/models',async(url)=>String(url)==='https://oauth2.googleapis.com/token'?Response.json({access_token:'token',expires_in:3600}):Response.json(value),signal()),error=>error.status===502);
 }
 let pages=0;
 await assert.rejects(vertexGeminiCatalog(credentials,'/v1beta/models',async(url)=>{
  if(String(url)==='https://oauth2.googleapis.com/token')return Response.json({access_token:'token',expires_in:3600});
  pages++;return Response.json({publisherModels:[{name:'publishers/google/models/gemini-known'}],nextPageToken:'repeat'});
 },signal()),/vertex_catalog_pagination_limit/);assert.equal(pages,20);
 const failed=Response.json({error:{status:'PERMISSION_DENIED'}},{status:403});
 assert.equal(await vertexGeminiCatalog(credentials,'/v1beta/models',async(url)=>String(url)==='https://oauth2.googleapis.com/token'?Response.json({access_token:'token',expires_in:3600}):failed,signal()),failed);
});
test('Vertex catalog selection uses service-account credentials and releases its gateway lease',async()=>{
 const finishes=[];let exchange=0;
 const app=createBackendHandler({url:'https://db.invalid',serviceKey:'private',encryptionKey:'',adminIds:[],dataModel:'native'},async(url,init)=>{
  if(String(url).endsWith('/s2a_personal_acquire'))return Response.json({lease_id:'lease',account:{id:'1',type:'service_account',platform:'gemini',credential_version:1,credential_storage:'vault',credentials}});
  if(String(url).endsWith('/s2a_personal_finish')){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
  if(String(url).includes('/rpc/')){assert.ok(!String(url).includes('refresh'));return Response.json(null);}
  if(String(url)==='https://oauth2.googleapis.com/token'){exchange++;return Response.json({access_token:'scoped-token',expires_in:3600});}
  assert.equal(new URL(url).hostname,'aiplatform.googleapis.com');return Response.json({publisherModels:[{name:'publishers/google/models/gemini-known'}]});
 });
 const response=await app(new Request('https://gateway/v1beta/models',{headers:{authorization:'Bearer sk-client'}}));
 assert.equal(response.status,200);assert.equal(exchange,1);assert.equal((await response.json()).models[0].name,'models/gemini-known');assert.equal(finishes.length,1);assert.equal(finishes[0].p_outcome,'completed');assert.equal(finishes[0].p_input_tokens,null);
});

test('Vertex publisher responses retain the original 8 MiB page limit and cancel oversized streams',async()=>{
 let canceled=false;
 await assert.rejects(vertexGeminiCatalog(credentials,'/v1beta/models',async(url)=>{
  if(String(url)==='https://oauth2.googleapis.com/token')return Response.json({access_token:'token',expires_in:3600});
  return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(8*1024*1024+1));},cancel(){canceled=true;}}));
 },signal()),/vertex_catalog_too_large/);
 assert.equal(canceled,true);
});
