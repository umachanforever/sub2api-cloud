import test from 'node:test';
import assert from 'node:assert/strict';
import {imageArtifactPath,putArtifact,getArtifact,signArtifact,deleteArtifacts,listTaskArtifacts} from '../supabase/functions/sub2api/artifact_storage.ts';
const task='imgtask_'+'a'.repeat(32),path=imageArtifactPath(task,'request');
function fixture(forward){return {config:{url:'https://project.supabase.co',serviceKey:'private-service-role'},fetchImpl:forward};}

test('artifact storage uploads opaque request bytes without multipart parsing',async()=>{
 const db=fixture(async(url,init)=>{
  assert.equal(url,'https://project.supabase.co/storage/v1/object/sub2api-artifacts/'+path);assert.equal(init.method,'POST');assert.equal(init.redirect,'error');
  const headers=new Headers(init.headers);assert.equal(headers.get('authorization'),'Bearer private-service-role');assert.equal(headers.get('content-type'),'application/octet-stream');assert.equal(headers.get('x-upsert'),'true');assert.deepEqual([...init.body],[0,1,255]);return Response.json({Key:'sub2api-artifacts/'+path});
 });
 await putArtifact(db,path,new Uint8Array([0,1,255]),'application/octet-stream');
});

test('authenticated object reads preserve content and apply the caller cancellation signal',async()=>{
 const abort=new AbortController();const db=fixture(async(url,init)=>{
  assert.equal(url,'https://project.supabase.co/storage/v1/object/authenticated/sub2api-artifacts/'+path);assert.equal(init.signal,abort.signal);assert.equal(init.redirect,'error');return new Response(new Uint8Array([0,255]),{headers:{'content-type':'application/octet-stream'}});
 });
 const response=await getArtifact(db,path,abort.signal);assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[0,255]);
});

test('result links are short-lived and restricted to the exact private object and project',async()=>{
 const result=imageArtifactPath(task,1,'png');
 const db=fixture(async(url,init)=>{
  assert.ok(url.endsWith('/object/sign/sub2api-artifacts/'+result));assert.deepEqual(JSON.parse(init.body),{expiresIn:600});return Response.json({signedURL:'/object/sign/sub2api-artifacts/'+result+'?token=signed-capability'});
 });
 const url=await signArtifact(db,result);assert.equal(url,'https://project.supabase.co/storage/v1/object/sign/sub2api-artifacts/'+result+'?token=signed-capability');assert.ok(!url.includes('private-service-role'));
});

test('invalid storage signatures cannot redirect clients or reveal other artifacts',async()=>{
 for(const signedURL of ['https://evil.example/result','/object/sign/sub2api-artifacts/'+path+'?token=x&apikey=private','/object/sign/sub2api-artifacts/'+imageArtifactPath(task,'result','json')+'?token=x','/object/sign/sub2api-artifacts/'+path,'https://user:secret@project.supabase.co/storage/v1/object/sign/sub2api-artifacts/'+path+'?token=x']){
  await assert.rejects(signArtifact(fixture(async()=>Response.json({signedURL})),path),error=>error.code==='invalid_artifact_signature');
 }
});

test('artifact deletion is limited to known image task objects',async()=>{
 const paths=[path,imageArtifactPath(task,'result','json'),imageArtifactPath(task,100,'webp')];
 const db=fixture(async(url,init)=>{assert.equal(url,'https://project.supabase.co/storage/v1/object/sub2api-artifacts');assert.equal(init.method,'DELETE');assert.deepEqual(JSON.parse(init.body),{prefixes:paths});return Response.json([]);});
 await deleteArtifacts(db,paths);
 for(const invalid of ['../secrets','images/'+task+'/../other','images/'+task+'/image-101.png','images/'+task+'/image-01.png'])await assert.rejects(deleteArtifacts(db,[invalid]),/invalid_artifact_path/);
 assert.throws(()=>imageArtifactPath(task,'unknown'),/invalid_artifact_path/);assert.throws(()=>imageArtifactPath(task,0),/invalid_artifact_path/);
});

test('storage failures and configured size limits return stable errors',async()=>{
 await assert.rejects(putArtifact(fixture(async()=>new Response('private-error',{status:413})),path,new Uint8Array([1]),'image/png'),error=>error.status===413&&error.code==='artifact_too_large');
 await assert.rejects(getArtifact(fixture(async()=>new Response('private-error',{status:404})),path,new AbortController().signal),error=>error.status===404&&error.code==='artifact_not_found');
 await assert.rejects(getArtifact(fixture(async()=>new Response('x',{headers:{'content-length':String(256*1024*1024+1)}})),path,new AbortController().signal),/artifact_too_large/);
 await assert.rejects(signArtifact(fixture(()=>assert.fail('Invalid expiry dispatched')),path,604801),/invalid_artifact_expiry/);
});

test('Supabase Storage HTTP 400 not-found envelopes remain a distinct missing object result',async()=>{
 await assert.rejects(getArtifact(fixture(async()=>Response.json({statusCode:'404',error:'not_found',message:'private path'},{status:400})),path,new AbortController().signal),error=>error.status===404&&error.code==='artifact_not_found'&&!error.message.includes('private path'));
 await assert.rejects(getArtifact(fixture(async()=>Response.json({statusCode:'403',error:'AccessDenied'},{status:400})),path,new AbortController().signal),error=>error.status===503);
});

test('task artifact inventory uses uncached metadata and rejects names outside the task folder',async()=>{
 const db=fixture(async(url,init)=>{assert.ok(url.endsWith('/object/list/sub2api-artifacts'));assert.equal(init.method,'POST');assert.equal(JSON.parse(init.body).prefix,'images/'+task);return Response.json([{name:'request.bin'},{name:'result.json'}]);});
 assert.deepEqual(await listTaskArtifacts(db,task),[path,imageArtifactPath(task,'result','json')]);
 await assert.rejects(listTaskArtifacts(fixture(async()=>Response.json([{name:'../another/result.json'}])),task),/invalid_artifact_listing/);
});
