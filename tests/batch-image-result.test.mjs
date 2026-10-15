import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBatchImageResult,batchImageResultLines} from '../supabase/functions/sub2api/batch_image_result.ts';
const bytes=value=>new TextEncoder().encode(value),line=(id='cover',inline='inlineData',mime='mimeType')=>JSON.stringify({key:id,response:{candidates:[{content:{parts:[{[inline]:{[mime]:'image/png',data:'YQ=='}}]}}]}});
test('batch result parser preserves native ID and inline image aliases without exposing error messages',()=>{
 for(const [inline,mime] of [['inlineData','mimeType'],['inline_data','mime_type']]){const item=parseBatchImageResult(bytes(line('cover',inline,mime)));assert.equal(item.status,'succeeded');assert.equal(item.images[0].data,'YQ==');assert.equal(item.file_extension,'png');}
 const value=JSON.parse(line());delete value.key;value.request={key:'nested'};value.candidates=value.response.candidates;delete value.response;assert.equal(parseBatchImageResult(bytes(JSON.stringify(value))).custom_id,'nested');
 for(const [error,code] of [[{code:3,message:'invalid argument private'},'INVALID_ARGUMENT'],[{status:'SAFETY',message:'private'},'SAFETY_BLOCKED'],[{code:'RESOURCE_EXHAUSTED',message:'private'},'PROVIDER_RATE_LIMITED']]){const item=parseBatchImageResult(bytes(JSON.stringify({customId:'a',error})));assert.equal(item.error_code,code);assert.ok(!JSON.stringify(item).includes('private'));}
 assert.equal(parseBatchImageResult(bytes('{"custom_id":"a","response":{}}')).error_code,'EMPTY_IMAGE_OUTPUT');assert.throws(()=>parseBatchImageResult(bytes('{"response":{}}')),/parse_failed/);
});
test('batch JSONL streaming preserves UTF8 and byte offsets across arbitrary chunk boundaries',async()=>{
 const first=line('中文'),wire=bytes(first+'\r\n\n'+line('last'));async function* chunks(){for(const byte of wire)yield new Uint8Array([byte]);}
 const rows=[];for await(const row of batchImageResultLines(chunks()))rows.push(row);assert.equal(rows.length,2);assert.equal(rows[0].item.custom_id,'中文');assert.equal(rows[0].byte_length,bytes(first).length+1);assert.equal(rows[1].line_number,3);assert.equal(rows[1].byte_offset,bytes(first).length+3);
});
test('batch JSONL enforces original per-line limit and releases upstream on interruption',async()=>{
 let closed=false;async function* chunks(){try{yield bytes(line()+'\n');yield bytes(line('next')+'\n');}finally{closed=true;}}
 for await(const row of batchImageResultLines(chunks())){assert.equal(row.item.custom_id,'cover');break;}assert.equal(closed,true);
 await assert.rejects(async()=>{for await(const row of batchImageResultLines(chunks(),10))void row;},/line_too_large/);
 async function* invalid(){yield new Uint8Array([255,10]);}await assert.rejects(async()=>{for await(const row of batchImageResultLines(invalid()))void row;},/parse_failed/);
});
test('batch usage preserves known zero values, thought tokens and unknown fields',()=>{
 const value=JSON.parse(line());value.response.usageMetadata={promptTokenCount:0,candidatesTokenCount:7,thoughtsTokenCount:3,cachedContentTokenCount:0,private:'secret'};
 assert.deepEqual(parseBatchImageResult(bytes(JSON.stringify(value))).usage,{input_tokens:0,output_tokens:10,cache_read_tokens:0});
 value.response.usageMetadata={promptTokenCount:-1,candidatesTokenCount:'7',thoughtsTokenCount:3,cachedContentTokenCount:NaN};assert.equal(parseBatchImageResult(bytes(JSON.stringify(value))).usage,undefined);
 value.response.usageMetadata={candidatesTokenCount:2147483647,thoughtsTokenCount:1};assert.equal(parseBatchImageResult(bytes(JSON.stringify(value))).usage,undefined);
});
