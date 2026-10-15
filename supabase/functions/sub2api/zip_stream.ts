import {HttpError} from './db.ts';
const table=Uint32Array.from({length:256},(_,value)=>{for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0;});
function crc32(bytes:Uint8Array):number{let crc=0xffffffff;for(const byte of bytes)crc=table[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function record(length:number):{bytes:Uint8Array;view:DataView}{const bytes=new Uint8Array(length);return {bytes,view:new DataView(bytes.buffer)};}
export type ZipEntry={name:string;bytes:Uint8Array};
// ZIP64 stored entries keep already-compressed images streaming without an aggregate buffer.
export async function* zipEntries(entries:AsyncIterable<ZipEntry>):AsyncGenerator<Uint8Array>{
 const central:Uint8Array[]=[];let offset=0n,count=0n;const names=new Set<string>();
 for await(const entry of entries){
  const name=new TextEncoder().encode(entry.name);
  if(!entry.name||name.length>65535||entry.name.startsWith('/')||/[\\\u0000-\u001f]/.test(entry.name)||entry.name.split('/').some(part=>part==='.'||part==='..'||!part)||names.has(entry.name)||!(entry.bytes instanceof Uint8Array))throw new HttpError(500,'invalid_zip_entry');names.add(entry.name);
  const size=BigInt(entry.bytes.length),crc=crc32(entry.bytes),local=record(30+name.length+20),v=local.view;
  v.setUint32(0,0x04034b50,true);v.setUint16(4,45,true);v.setUint16(6,0x800,true);v.setUint16(12,0x21,true);v.setUint32(14,crc,true);v.setUint32(18,0xffffffff,true);v.setUint32(22,0xffffffff,true);v.setUint16(26,name.length,true);v.setUint16(28,20,true);local.bytes.set(name,30);
  const extra=30+name.length;v.setUint16(extra,1,true);v.setUint16(extra+2,16,true);v.setBigUint64(extra+4,size,true);v.setBigUint64(extra+12,size,true);
  const header=record(46+name.length+28),c=header.view;
  c.setUint32(0,0x02014b50,true);c.setUint16(4,45,true);c.setUint16(6,45,true);c.setUint16(8,0x800,true);c.setUint16(14,0x21,true);c.setUint32(16,crc,true);c.setUint32(20,0xffffffff,true);c.setUint32(24,0xffffffff,true);c.setUint16(28,name.length,true);c.setUint16(30,28,true);c.setUint32(42,0xffffffff,true);header.bytes.set(name,46);
  const e=46+name.length;c.setUint16(e,1,true);c.setUint16(e+2,24,true);c.setBigUint64(e+4,size,true);c.setBigUint64(e+12,size,true);c.setBigUint64(e+20,offset,true);central.push(header.bytes);
  yield local.bytes;yield entry.bytes;offset+=BigInt(local.bytes.length)+size;count++;
 }
 const start=offset;for(const bytes of central){yield bytes;offset+=BigInt(bytes.length);}
 const end=record(56),v=end.view;v.setUint32(0,0x06064b50,true);v.setBigUint64(4,44n,true);v.setUint16(12,45,true);v.setUint16(14,45,true);v.setBigUint64(24,count,true);v.setBigUint64(32,count,true);v.setBigUint64(40,offset-start,true);v.setBigUint64(48,start,true);yield end.bytes;
 const locator=record(20);locator.view.setUint32(0,0x07064b50,true);locator.view.setBigUint64(8,offset,true);locator.view.setUint32(16,1,true);yield locator.bytes;
 const legacy=record(22),l=legacy.view;l.setUint32(0,0x06054b50,true);l.setUint16(8,0xffff,true);l.setUint16(10,0xffff,true);l.setUint32(12,0xffffffff,true);l.setUint32(16,0xffffffff,true);yield legacy.bytes;
}
export function zipStream(entries:AsyncIterable<ZipEntry>):ReadableStream<Uint8Array>{
 const iterator=zipEntries(entries);
 return new ReadableStream({async pull(controller){try{const part=await iterator.next();if(part.done)controller.close();else controller.enqueue(part.value);}catch(error){controller.error(error);await iterator.return(undefined).catch(()=>{});}},async cancel(){await iterator.return(undefined);}});
}
