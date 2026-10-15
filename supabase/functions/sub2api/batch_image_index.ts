import {Database,HttpError} from './db.ts';
import {putArtifact} from './artifact_storage.ts';
import {batchImageResultLines} from './batch_image_result.ts';
import type {GeminiBatchInput} from './gemini_batch.ts';
export type BatchIndexedItem={custom_id:string;status:'success'|'failed';image_count:number;provider_source_object?:string;source_line_number?:number;source_byte_offset?:number;source_byte_length?:number;mime_type?:string;file_extension?:string;error_code?:string};
export async function indexBatchImageResults(db:Database,job:{batch_id:string;lease_id:string},input:GeminiBatchInput,chunks:AsyncIterable<Uint8Array>,signal:AbortSignal):Promise<boolean>{
 if(!/^imgbatch_[a-f0-9]{32}$/.test(job.batch_id)||!input.items.length||input.items.length>200)throw new HttpError(503,'invalid_batch_index_input');
 const expected=new Map(input.items.map((item,index)=>[item.custom_id,index+1]));
 if(expected.size!==input.items.length)throw new HttpError(503,'invalid_batch_index_input');
 const seen=new Set<string>(),items:BatchIndexedItem[]=[];
 for await(const line of batchImageResultLines(chunks)){
  signal.throwIfAborted();const item=line.item,ordinal=expected.get(item.custom_id);if(!ordinal)continue;
  if(seen.has(item.custom_id))throw new HttpError(502,'batch_image_duplicate_custom_id');seen.add(item.custom_id);
  const indexed:BatchIndexedItem={custom_id:item.custom_id,status:item.status==='succeeded'?'success':'failed',image_count:item.image_count,source_line_number:line.line_number,source_byte_offset:line.byte_offset,source_byte_length:line.byte_length};
  if(item.status==='succeeded'){
   const path=`batches/${job.batch_id}/item-${ordinal}.json`;
   await putArtifact(db,path,new TextEncoder().encode(JSON.stringify({custom_id:item.custom_id,images:item.images})),'application/octet-stream',signal);
   indexed.provider_source_object=path;indexed.mime_type=item.mime_type;indexed.file_extension=item.file_extension;
  }else indexed.error_code=item.error_code;
  items.push(indexed);
 }
 for(const custom_id of expected.keys())if(!seen.has(custom_id))items.push({custom_id,status:'failed',image_count:0,error_code:'PROVIDER_RESULT_MISSING'});
 const saved=await db.rpc<Record<string,unknown>>('s2a_batch_image_runtime_indexed',{p_id:job.batch_id,p_lease:job.lease_id,p_items:items});
 if(!saved||typeof saved!=='object'||typeof saved.applied!=='boolean'){
  if(typeof saved?.error==='string')throw new HttpError(typeof saved.status==='number'?saved.status:503,saved.error);
  throw new HttpError(503,'invalid_batch_index_response');
 }
 return true;
}
