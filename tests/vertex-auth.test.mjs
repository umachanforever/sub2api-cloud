import test from 'node:test';
import assert from 'node:assert/strict';
import {VertexServiceAccountToken,vertexTokenProvider,invalidateVertexTokenContext} from '../supabase/functions/sub2api/vertex_auth.ts';
const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const exported=Buffer.from(await crypto.subtle.exportKey('pkcs8',pair.privateKey)).toString('base64');
const key={project_id:'project-1',client_email:'svc@project-1.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----\n'+exported+'\n-----END PRIVATE KEY-----',private_key_id:'key-1',token_uri:'https://evil.example/token'};
test('Vertex cross-request cache coalesces exchanges and isolates credentials, proxy identities and database scopes',async()=>{
 let calls=0;
 const fetcher=async()=>Response.json({access_token:'token-'+(++calls),expires_in:3600});
 const context={scope:{},identity:'account:version:proxy'};
 const providers=await Promise.all(Array.from({length:12},()=>vertexTokenProvider({service_account:key},fetcher,context)));
 const tokens=await Promise.all(providers.map(provider=>provider.accessToken()));
 assert.deepEqual(tokens,Array(12).fill('token-1'));assert.equal(calls,1);
 for(const [credentials,scope] of [
  [{service_account:key},{...context,identity:'account:version:other-proxy'}],
  [{service_account:key},{...context,scope:{}}],
  [{service_account:{...key,private_key_id:'rotated'}},context],
  [{service_account:{...key,client_email:'other@project.iam.gserviceaccount.com'}},context],
 ])await (await vertexTokenProvider(credentials,fetcher,scope)).accessToken();
 assert.equal(calls,5);
 const original=await vertexTokenProvider({service_account:key},fetcher,context);
 assert.equal(await original.accessToken(),'token-1');
 invalidateVertexTokenContext(context);
 assert.notEqual(await vertexTokenProvider({service_account:key},fetcher,context),original);
 for(let i=0;i<32;i++)await vertexTokenProvider({service_account:key},fetcher,{...context,identity:'eviction-'+i});
 assert.notEqual(await vertexTokenProvider({service_account:key},fetcher,context),original);
});
test('Vertex signs valid Google assertions, ignores token_uri and deduplicates refreshes',async()=>{
 let now=1800000000000,calls=0;
 const provider=new VertexServiceAccountToken({service_account_json:JSON.stringify(key)},async(url,init)=>{
  calls++;assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(init.redirect,'error');const form=new URLSearchParams(init.body);assert.equal(form.get('grant_type'),'urn:ietf:params:oauth:grant-type:jwt-bearer');const [header,payload,signature]=form.get('assertion').split('.');assert.deepEqual(JSON.parse(Buffer.from(header,'base64url')),{alg:'RS256',typ:'JWT',kid:'key-1'});const claims=JSON.parse(Buffer.from(payload,'base64url'));assert.equal(claims.iss,key.client_email);assert.equal(claims.aud,url);assert.equal(claims.scope,'https://www.googleapis.com/auth/cloud-platform');assert.equal(claims.exp-claims.iat,3600);assert.equal(await crypto.subtle.verify('RSASSA-PKCS1-v1_5',pair.publicKey,Buffer.from(signature,'base64url'),new TextEncoder().encode(header+'.'+payload)),true);
  return Response.json({access_token:'private-token-'+calls,expires_in:3600,token_type:'Bearer'});
 },()=>now);
 assert.deepEqual(await Promise.all(Array.from({length:10},()=>provider.accessToken())),Array(10).fill('private-token-1'));assert.equal(calls,1);assert.equal(await provider.accessToken(),'private-token-1');now+=3550000;assert.equal(await provider.accessToken(),'private-token-2');assert.equal(calls,2);assert.equal(provider.project,'project-1');assert.ok(!JSON.stringify(provider).includes('PRIVATE KEY'));assert.ok(!JSON.stringify(provider).includes('private-token'));
});
test('Vertex rejects invalid credentials and sanitizes token failures without caching them',async()=>{
 for(const value of [{},{service_account_json:'bad'},{service_account:{}},{service_account_json:{...key,client_email:'bad'}}])assert.throws(()=>new VertexServiceAccountToken(value),/invalid_vertex_credentials/);
 const invalid=new VertexServiceAccountToken({service_account:{...key,private_key:'private'}},()=>assert.fail('invalid key reached network'));await assert.rejects(invalid.accessToken(),/invalid_vertex_private_key/);
 for(const response of [()=>new Response('private upstream detail',{status:403}),()=>Response.json({access_token:'private',expires_in:'3600'}),()=>Response.json({access_token:'bad\r\nheader',expires_in:3600}),()=>new Response('invalid'),()=>new Response('x'.repeat(1024*1024+1))]){
  let calls=0;const provider=new VertexServiceAccountToken({service_account:key},async()=>{calls++;return response();});for(let i=0;i<2;i++)await assert.rejects(provider.accessToken(),error=>error.status===502&&!error.message.includes('private'));assert.equal(calls,2);
 }
});
test('account-bound batch client uses service-account tokens for native Vertex requests',async()=>{
 const {Database}=await import('../supabase/functions/sub2api/db.ts');const {vertexBatchAccountClient}=await import('../supabase/functions/sub2api/vertex_batch.ts');let calls=0;
 const db=new Database({url:'https://db.invalid',serviceKey:'service'},async(url,init)=>{calls++;if(String(url)==='https://oauth2.googleapis.com/token')return Response.json({access_token:'scoped-token',expires_in:3600});assert.equal(new Headers(init.headers).get('authorization'),'Bearer scoped-token');return Response.json({name:'projects/project-1/locations/global/batchPredictionJobs/123',state:'JOB_STATE_RUNNING'});});
 const client=vertexBatchAccountClient(db,{platform:'gemini',type:'service_account'},{service_account:key});assert.equal((await client.getBatch('projects/project-1/locations/global/batchPredictionJobs/123',AbortSignal.timeout(5000))).status,'running');assert.equal(calls,2);
 assert.throws(()=>vertexBatchAccountClient(db,{platform:'gemini',type:'apikey'},{service_account:key}),/vertex_batch_account_required/);
});
