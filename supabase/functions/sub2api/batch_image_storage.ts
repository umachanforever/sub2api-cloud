import {Database,HttpError} from './db.ts';
import {getArtifact,putArtifact} from './artifact_storage.ts';
import {batchImageInput} from './batch_image_input.ts';
import {imageBytesHash} from './image_task_submit.ts';
import {vertexBatchResource} from './vertex_batch.ts';

type Binding={batchID:string;requestHash:string;provider:'gemini_api'|'vertex'};
function path(binding:Binding,name:'request'|'created'):string{
 if(!/^imgbatch_[a-f0-9]{32}$/.test(binding.batchID)||!/^[a-f0-9]{64}$/.test(binding.requestHash)||!['gemini_api','vertex'].includes(binding.provider))throw new HttpError(400,'invalid_batch_storage_binding');
 return `batches/${binding.batchID}/${name}.json`;
}
async function bytes(response:Response,limit:number):Promise<Uint8Array>{
 const reader=response.body?.getReader();if(!reader)throw new HttpError(502,'invalid_batch_artifact');
 const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>limit)throw new HttpError(502,'invalid_batch_artifact');chunks.push(part.value);}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
}
function decode(value:Uint8Array):Record<string,unknown>{try{const result=JSON.parse(new TextDecoder().decode(value));if(!result||typeof result!=='object'||Array.isArray(result))throw Error('shape');return result;}catch{throw new HttpError(502,'invalid_batch_artifact');}}
function providerName(binding:Binding,name:unknown):string{
 if(binding.provider==='vertex')return vertexBatchResource(name);
 if(typeof name!=='string'||!/^batches\/[A-Za-z0-9_.-]{1,200}$/.test(name)||['.','..'].includes(name.split('/')[1]))throw new HttpError(502,'invalid_batch_provider_receipt');return name;
}
export async function storeBatchRequest(db:Database,batchID:string,input:unknown,signal:AbortSignal):Promise<{requestHash:string;input:ReturnType<typeof batchImageInput>}>{
 const normalized=batchImageInput(input),body=new TextEncoder().encode(JSON.stringify(normalized)),requestHash=await imageBytesHash(body);
 await putArtifact(db,path({batchID,requestHash,provider:normalized.provider==='vertex'?'vertex':'gemini_api'},'request'),body,'application/octet-stream',signal);return {requestHash,input:normalized};
}
export async function loadBatchRequest(db:Database,binding:Binding,signal:AbortSignal):Promise<ReturnType<typeof batchImageInput>>{
 const body=await bytes(await getArtifact(db,path(binding,'request'),signal),256*1024*1024);
 if(await imageBytesHash(body)!==binding.requestHash)throw new HttpError(502,'batch_request_hash_mismatch');
 const input=batchImageInput(decode(body));
 if(input.provider&&input.provider!==binding.provider)throw new HttpError(502,'batch_request_provider_mismatch');return input;
}
export async function storeBatchCreated(db:Database,binding:Binding,name:string,signal:AbortSignal):Promise<void>{
 const body=new TextEncoder().encode(JSON.stringify({batch_id:binding.batchID,request_hash:binding.requestHash,provider:binding.provider,name:providerName(binding,name)}));
 await putArtifact(db,path(binding,'created'),body,'application/octet-stream',signal);
}
export async function loadBatchCreated(db:Database,binding:Binding,signal:AbortSignal):Promise<string|null>{
 let response:Response;try{response=await getArtifact(db,path(binding,'created'),signal);}catch(error){if(error instanceof HttpError&&error.status===404)return null;throw error;}
 const receipt=decode(await bytes(response,16384));
 if(receipt.batch_id!==binding.batchID||receipt.request_hash!==binding.requestHash||receipt.provider!==binding.provider)throw new HttpError(502,'batch_receipt_binding_mismatch');return providerName(binding,receipt.name);
}
