import {accountFetch} from './account_proxy.ts';
import {HttpError} from './db.ts';
import type {Database} from './db.ts';
import {VertexServiceAccountToken} from './vertex_auth.ts';
import {VertexBatchClient,buildVertexBatchJSONL} from './vertex_batch.ts';
import {VertexBatchStorage} from './vertex_gcs.ts';
import type {GeminiBatchInput,GeminiBatchStatus} from './gemini_batch.ts';

export type VertexBatchCheckpoint={input_ref:string;output_ref:string};
export class VertexBatchProvider{
 #client:VertexBatchClient;#storage:VertexBatchStorage;
 constructor(client:VertexBatchClient,storage:VertexBatchStorage){this.#client=client;this.#storage=storage;}
 // The caller must durably fence a create intent before invoking createUploadedBatch.
 async uploadInput(input:GeminiBatchInput,signal:AbortSignal):Promise<VertexBatchCheckpoint>{
  await this.#storage.uploadInput(buildVertexBatchJSONL(input),signal);
  return {input_ref:this.#storage.inputURI,output_ref:this.#storage.outputURI};
 }
 async createUploadedBatch(model:string,displayName:string,checkpoint:VertexBatchCheckpoint,signal:AbortSignal):Promise<GeminiBatchStatus>{
  this.#checkpoint(checkpoint);return this.#client.createBatch(model,checkpoint.input_ref,checkpoint.output_ref,displayName,signal);
 }
 #checkpoint(value:VertexBatchCheckpoint):void{
  if(value?.input_ref!==this.#storage.inputURI||value?.output_ref!==this.#storage.outputURI)throw new HttpError(409,'vertex_batch_checkpoint_mismatch');
 }
 async getBatch(name:string,signal:AbortSignal):Promise<GeminiBatchStatus>{
  const result=await this.#client.getBatch(name,signal,this.#storage.outputURI);
  // Provider-generated result subdirectories are accepted only inside this task's output prefix.
  if(result.output_ref&&!result.output_ref.startsWith(this.#storage.outputURI))throw new HttpError(502,'vertex_batch_output_mismatch');
  return result;
 }
 cancelBatch(name:string,signal:AbortSignal):Promise<void>{return this.#client.cancelBatch(name,signal);}
 resultChunks(signal:AbortSignal):AsyncGenerator<Uint8Array>{return this.#storage.resultChunks(signal);}
 deleteInput(signal:AbortSignal):Promise<void>{return this.#storage.deleteObject(this.#storage.inputURI,signal);}
 deleteOutputs(signal:AbortSignal):Promise<void>{return this.#storage.deleteOutputs(signal);}
}
export function vertexBatchProvider(db:Database,account:{platform?:string;type?:string;proxy_id?:number|string|null;credential_storage?:string},credentials:Record<string,unknown>,options:{bucket:string;batchID:string;location?:string;environment?:string}):VertexBatchProvider{
 if(account.platform!=='gemini'||account.type!=='service_account')throw new HttpError(400,'vertex_batch_account_required');
 const fetcher:typeof fetch=(input,init)=>accountFetch(db,account,input,init),tokens=new VertexServiceAccountToken(credentials,fetcher),token=()=>tokens.accessToken();
 return new VertexBatchProvider(new VertexBatchClient(tokens.project,options.location??'global',token,fetcher),new VertexBatchStorage(options.bucket,options.batchID,token,fetcher,options.environment));
}
