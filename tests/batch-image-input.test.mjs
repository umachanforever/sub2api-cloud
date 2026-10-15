import test from 'node:test';
import assert from 'node:assert/strict';
import {batchImageInput,DEFAULT_BATCH_IMAGE_LIMITS as defaults} from '../supabase/functions/sub2api/batch_image_input.ts';
import {buildGeminiBatchJSONL} from '../supabase/functions/sub2api/gemini_batch.ts';
const model='gemini-3.1-flash-image';

test('batch normalization expands output counts into stable unique IDs and original Gemini JSONL',()=>{
 const input={model,items:[{custom_id:' cover ',prompt:' Blue square ',output_count:2},{prompt:' Green square '} ]},value=batchImageInput(input,defaults,new Date('2026-10-15T16:00:00Z'));
 assert.deepEqual(value.items.map(item=>item.custom_id),['cover_01','cover_02','item_000002']);assert.equal(value.items[0].prompt,'Blue square');assert.equal(value.task_name,'2026-10-16 00:00:00');assert.equal(value.image_size,'1K');assert.equal(value.response_mime_type,'image/png');assert.equal(input.items[0].output_count,2);assert.equal(new TextDecoder().decode(buildGeminiBatchJSONL(value)).trim().split('\n').length,3);
});

test('batch output limits count expanded requests and reject generated-ID collisions',()=>{
 assert.throws(()=>batchImageInput({model,items:[{custom_id:'a',prompt:'one',output_count:2},{custom_id:'a_01',prompt:'two'}]}),/duplicate_batch_custom_id/);
 assert.throws(()=>batchImageInput({model,items:Array.from({length:51},(_,i)=>({custom_id:String(i),prompt:'one',output_count:4}))}),/batch_output_limit_exceeded/);
 for(const output_count of [-1,5,1.5,'2',null])assert.throws(()=>batchImageInput({model,items:[{prompt:'one',output_count}]}),/batch_output_limit_exceeded/);
 assert.equal(batchImageInput({model,items:[{prompt:'one',output_count:0}]}).items.length,1);
});

test('reference budgets include every expanded output and use model-specific image limits',()=>{
 const ref={id:' style ',type:' reference ',mime_type:'IMAGE/JPG',data:'YQ=='},value=batchImageInput({model,items:[{prompt:'one',output_count:2,reference_images:[ref]}]});assert.equal(value.items[0].reference_images[0].mime_type,'image/jpeg');assert.equal(value.items[0].reference_images[0].id,'style');assert.equal(value.items[0].reference_images[0].type,'reference');
 assert.throws(()=>batchImageInput({model,items:[{prompt:'one',output_count:2,reference_images:[ref]}]},{...defaults,referenceBytes:1}),/batch_reference_limit_exceeded/);
 assert.throws(()=>batchImageInput({model,items:[{prompt:'one',output_count:2,reference_images:[ref]}]},{...defaults,references:1}),/batch_reference_limit_exceeded/);
 assert.throws(()=>batchImageInput({model,items:[{prompt:'one',reference_images:Array(4).fill(ref)}]}),/batch_reference_limit_exceeded/);
 assert.equal(batchImageInput({model:'gemini-3-pro-image-preview',items:[{prompt:'one',reference_images:Array(14).fill(ref)}]}).items[0].reference_images.length,14);
 assert.throws(()=>batchImageInput({model:'image-alias',items:[{prompt:'one',reference_images:[ref]}]}),/batch_reference_limit_exceeded/);
});

test('references require one valid base64 body or a GCS object reference',()=>{
 for(const ref of [{mime_type:'image/png'},{mime_type:'image/png',data:'YQ==',file_uri:'gs://bucket/image'},{mime_type:'text/plain',data:'YQ=='},{mime_type:'image/png',data:'a!'},{mime_type:'image/png',file_uri:'https://evil.example/image'}])assert.throws(()=>batchImageInput({model,items:[{prompt:'one',reference_images:[ref]}]}),/invalid_batch_reference/);
 assert.equal(batchImageInput({model,items:[{prompt:'one',reference_images:[{mime_type:'image/png',file_uri:'gs://bucket/path/image.png'}]}]}).items[0].reference_images[0].file_uri,'gs://bucket/path/image.png');
});

test('prompt and metadata bounds preserve valid Unicode and prevent object prototype mutation',()=>{
 assert.throws(()=>batchImageInput({model,items:[{prompt:'中'.repeat(2667)}]}),/batch_prompt_too_long/);
 const metadata=JSON.parse('{"__proto__":"retained safely"," ":"skip","z":"value"}');metadata.a='中'.repeat(100);
 const value=batchImageInput({model,task_name:'中'.repeat(100),metadata,items:[{prompt:'one'}]});assert.equal(new TextEncoder().encode(value.task_name).length,255);assert.equal(new TextEncoder().encode(value.metadata.a).length,255);assert.equal(Object.getPrototypeOf(value.metadata),null);assert.equal(value.metadata.__proto__,'retained safely');assert.equal({}.polluted,undefined);
 const many=Object.fromEntries(Array.from({length:25},(_,i)=>['key-'+i,'value']));assert.equal(Object.keys(batchImageInput({model,metadata:many,items:[{prompt:'one'}]}).metadata).length,20);
});

test('batch options retain both upstream providers and enforce native schema and image-size bounds',()=>{
 for(const provider of ['gemini_api','vertex',''])assert.equal(batchImageInput({model,provider,image_size:'1k',items:[{prompt:'one'}]}).provider,provider);
 for(const override of [{provider:'openai'},{model:'../private'},{image_size:'2K'},{parent_batch_id:'../other'},{items:[]},{items:Array(201).fill({prompt:'one'})}])assert.throws(()=>batchImageInput({model,items:[{prompt:'one'}],...override}),error=>error.status===400);
 assert.throws(()=>batchImageInput({model,items:[{custom_id:'x'.repeat(254),prompt:'one',output_count:2}]}),/invalid_batch_custom_id/);
});

test('incomplete configuration is rejected and line-wrapped base64 is normalized before JSONL encoding',()=>{
 assert.throws(()=>batchImageInput({model,items:[{prompt:'one'}]},{outputs:200}),/invalid_batch_limits/);
 const value=batchImageInput({model,items:[{prompt:'one',reference_images:[{mime_type:'image/png',data:'YQ==\r\n'}]}]});assert.equal(value.items[0].reference_images[0].data,'YQ==');
});
