import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {Database} from '../supabase/functions/sub2api/db.ts';
import {downloadBatchImages} from '../supabase/functions/sub2api/batch_image_download.ts';
const id='imgbatch_'+'a'.repeat(32);
test('batch ZIP downloads authorized private images with manifest and sanitized item errors',async()=>{
 const db=new Database({url:'https://db.invalid',serviceKey:'service'},async(url)=>{
  const name=String(url).split('/').at(-1);
  if(name==='s2a_batch_image_read')return Response.json({id,status:'completed',model:'gemini-image',item_count:2,success_count:1,fail_count:1,items:[{custom_id:'../../cover',status:'success',image_count:1},{custom_id:'missing',status:'failed',image_count:0,error_code:'PROVIDER_RESULT_MISSING'}]});
  if(name==='s2a_batch_image_content_resolve')return Response.json({custom_id:'../../cover',path:`batches/${id}/item-1.json`,image_count:1});
  return Response.json({custom_id:'../../cover',images:[{mime_type:'image/png',extension:'png',data:'YQ=='}]});
 });
 const response=await downloadBatchImages(db,'hash',id);assert.equal(response.headers.get('content-type'),'application/zip');const archive=Buffer.from(await response.arrayBuffer());
 const output=execFileSync('python3',['-c',`import io,zipfile,json,sys
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:
 assert z.testzip() is None
 assert z.read('images/item-000001-1.png')==b'a'
 print(json.dumps({'manifest':json.loads(z.read('manifest.json')),'errors':json.loads(z.read('errors.json'))}))`],{input:archive,encoding:'utf8'});
 const result=JSON.parse(output);assert.equal(result.manifest.files[0].custom_id,'../../cover');assert.equal(result.errors[0].error_code,'PROVIDER_RESULT_MISSING');
});
test('batch ZIP rejects denied, processing and expired tasks before streaming',async()=>{
 for(const snapshot of [{error:'batch_image_forbidden',status:403},{id,status:'running',items:[]},{id,status:'completed',items:[],output_expires_at:'2000-01-01T00:00:00Z'}]){let calls=0;const db=new Database({url:'https://db.invalid',serviceKey:'service'},async()=>{calls++;return Response.json(snapshot);});await assert.rejects(downloadBatchImages(db,'hash',id));assert.equal(calls,1);}
});
test('client ZIP item caps reject excess successful items before reading media',async()=>{
 let calls=0;const db=new Database({url:'https://db.invalid',serviceKey:'service'},async()=>{calls++;return Response.json({id,status:'completed',items:[{custom_id:'a',status:'success',image_count:1},{custom_id:'b',status:'success',image_count:1}]});});
 await assert.rejects(downloadBatchImages(db,'hash',id,null,{maxItems:1}),/batch_image_zip_too_many_items/);assert.equal(calls,1);
});
