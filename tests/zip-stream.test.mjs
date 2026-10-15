import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {zipEntries,zipStream} from '../supabase/functions/sub2api/zip_stream.ts';
test('streamed ZIP64 archives are readable by independent Python zipfile with Unicode names and verified CRCs',async()=>{
 async function* entries(){yield {name:'images/中文.png',bytes:new Uint8Array([0,1,2,255])};yield {name:'manifest.json',bytes:new TextEncoder().encode('{"count":1}')};}
 const bytes=Buffer.from(await new Response(zipStream(entries())).arrayBuffer());
 const result=execFileSync('python3',['-c',`import io,json,sys,zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
 assert archive.testzip() is None
 print(json.dumps({name:list(archive.read(name)) for name in archive.namelist()},ensure_ascii=False))`],{input:bytes,encoding:'utf8'});
 assert.deepEqual(JSON.parse(result)['images/中文.png'],[0,1,2,255]);assert.equal(new TextDecoder().decode(new Uint8Array(JSON.parse(result)['manifest.json'])),'{"count":1}');
});
test('ZIP generation is lazy, closes upstream on cancellation and rejects duplicate or escaped paths',async()=>{
 let read=0,closed=false;async function* entries(){try{read++;yield {name:'first',bytes:new Uint8Array([1])};read++;yield {name:'second',bytes:new Uint8Array([2])};}finally{closed=true;}}
 const iterator=zipEntries(entries());await iterator.next();assert.equal(read,1);await iterator.return();assert.equal(closed,true);
 for(const names of [['../escape'],['/absolute'],['a\\b'],['a','a']]){async function* invalid(){for(const name of names)yield {name,bytes:new Uint8Array()};}await assert.rejects(async()=>{for await(const chunk of zipEntries(invalid()))void chunk;},/invalid_zip_entry/);}
});
