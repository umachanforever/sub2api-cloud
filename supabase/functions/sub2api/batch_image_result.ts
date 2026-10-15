import {HttpError} from './db.ts';
type Row=Record<string,any>;
export type BatchResultImage={mime_type:string;extension:string;data:string};
export type BatchResultItem={custom_id:string;status:'succeeded'|'failed';image_count:number;mime_type?:string;file_extension?:string;error_code?:string;images:BatchResultImage[]};
const object=(value:unknown):value is Row=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const text=(value:unknown)=>typeof value==='string'?value.trim():typeof value==='number'&&Number.isFinite(value)?String(Math.trunc(value)):'';
function images(candidates:unknown):BatchResultImage[]{
 const result:BatchResultImage[]=[];
 if(!Array.isArray(candidates))return result;
 for(const candidate of candidates){
  if(!object(candidate)||!object(candidate.content)||!Array.isArray(candidate.content.parts))continue;
  for(const part of candidate.content.parts){
   if(!object(part))continue;
   const inline=object(part.inlineData)?part.inlineData:object(part.inline_data)?part.inline_data:null;if(!inline)continue;
   const data=text(inline.data),mime=text(inline.mimeType)||text(inline.mime_type);if(!data||!mime.toLowerCase().startsWith('image/'))continue;
   const normalized=mime.toLowerCase();result.push({mime_type:mime,extension:normalized==='image/png'?'png':['image/jpeg','image/jpg'].includes(normalized)?'jpg':normalized==='image/webp'?'webp':'',data});
  }
 }
 return result;
}
export function parseBatchImageResult(line:Uint8Array):BatchResultItem{
 let row:Row;try{row=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line));if(!object(row))throw Error('shape');}catch{throw new HttpError(502,'batch_image_index_parse_failed');}
 const id=text(row.key)||text(row.custom_id)||text(row.customId)||(object(row.request)?text(row.request.key):'');
 if(!id||new TextEncoder().encode(id).length>255||/[\u0000-\u001f]/.test(id))throw new HttpError(502,'batch_image_index_parse_failed');
 const response=object(row.response)?row.response:null,found=images(response?.candidates),output=found.length?found:images(row.candidates);
 if(output.length)return {custom_id:id,status:'succeeded',image_count:output.length,mime_type:output[0].mime_type,file_extension:output[0].extension,images:output};
 const error=object(row.status)?row.status:object(row.error)?row.error:null;let code='PROVIDER_ITEM_FAILED';
 if(error){
  const message=(text(error.code)+' '+text(error.status)+' '+text(error.message)+' '+text(error.details)).toLowerCase();
  if(/safety|policy|blocked|prohibited/.test(message))code='SAFETY_BLOCKED';
  else if(/invalid_argument|invalid argument|bad request/.test(message))code='INVALID_ARGUMENT';
  else if(/quota|rate|resource_exhausted|too many requests/.test(message))code='PROVIDER_RATE_LIMITED';
 }else if('response' in row||'candidates' in row)code='EMPTY_IMAGE_OUTPUT';
 return {custom_id:id,status:'failed',image_count:0,error_code:code,images:[]};
}
export type BatchResultLine={item:BatchResultItem;line_number:number;byte_offset:number;byte_length:number};
// Match the original 16 MiB JSONL line limit without limiting the total result size.
export async function* batchImageResultLines(chunks:AsyncIterable<Uint8Array>,maxLineBytes=16*1024*1024):AsyncGenerator<BatchResultLine>{
 if(!Number.isSafeInteger(maxLineBytes)||maxLineBytes<1)throw new HttpError(500,'invalid_batch_line_limit');
 let pending:Uint8Array[]=[],size=0,offset=0,lineNumber=0;
 const append=(part:Uint8Array)=>{size+=part.length;if(size>maxLineBytes)throw new HttpError(502,'batch_image_result_line_too_large');if(part.length)pending.push(part);};
 function take():Uint8Array{const bytes=new Uint8Array(size);let cursor=0;for(const part of pending){bytes.set(part,cursor);cursor+=part.length;}pending=[];size=0;return bytes;}
 for await(const chunk of chunks){
  if(!(chunk instanceof Uint8Array))throw new HttpError(502,'invalid_batch_result_chunk');
  let start=0;
  for(let index=0;index<chunk.length;index++)if(chunk[index]===10){
   append(chunk.subarray(start,index));const line=take(),length=line.length;lineNumber++;
   if(new TextDecoder().decode(line).trim())yield {item:parseBatchImageResult(line),line_number:lineNumber,byte_offset:offset,byte_length:length};
   offset+=length+1;start=index+1;
  }
  append(chunk.subarray(start));
 }
 if(size){const line=take();lineNumber++;if(new TextDecoder().decode(line).trim())yield {item:parseBatchImageResult(line),line_number:lineNumber,byte_offset:offset,byte_length:line.length};}
}
