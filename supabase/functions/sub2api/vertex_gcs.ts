import {HttpError} from './db.ts';
import {VertexBatchRequestError,vertexBatchManagedRefs} from './vertex_batch.ts';
const origin='https://storage.googleapis.com';
// Bind storage operations to one managed task before attaching its bearer token.
export class VertexBatchStorage{
 #bucket:string;#input:string;#output:string;#token:()=>Promise<string>;#fetch:typeof fetch;
 constructor(bucket:string,batchID:string,token:()=>Promise<string>,fetcher:typeof fetch=fetch,environment='production'){
  const refs=vertexBatchManagedRefs(bucket,batchID,environment);this.#bucket=bucket;this.#input=refs.input;this.#output=refs.output;this.#token=token;this.#fetch=fetcher;
 }
 get inputURI():string{return this.#input;}
 get outputURI():string{return this.#output;}
 #path(uri:string,outputOnly=false):string{
  if(uri!==this.#input&&(!uri.startsWith(this.#output)||uri.length===this.#output.length)||outputOnly&&!uri.startsWith(this.#output))throw new HttpError(400,'unsafe_vertex_storage_path');
  const path=uri.slice(('gs://'+this.#bucket+'/').length);
  if(/[\u0000-\u001f]/.test(path)||path.split('/').some(part=>part==='.'||part==='..'))throw new HttpError(400,'unsafe_vertex_storage_path');return path;
 }
 async #request(path:string,method:string,signal:AbortSignal,body?:Uint8Array,missingOK=false):Promise<Response>{
  const token=await this.#token();if(typeof token!=='string'||!token||/[\r\n]/.test(token))throw new HttpError(503,'vertex_token_unavailable');
  let response:Response;
  try{response=await this.#fetch(origin+path,{method,signal,redirect:'error',headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/jsonl'}:{})},...(body?{body:body as unknown as BodyInit}:{})});}
  catch{throw new VertexBatchRequestError('VERTEX_GCS_TRANSPORT_FAILED',method==='POST');}
  if(!response.ok&&!(missingOK&&response.status===404)){await response.body?.cancel().catch(()=>{});throw new VertexBatchRequestError('VERTEX_GCS_REQUEST_FAILED',method==='POST'&&(response.status===408||response.status>=500||response.status<400),response.status);}
  return response;
 }
 async uploadInput(bytes:Uint8Array,signal:AbortSignal):Promise<string>{
  if(!bytes.byteLength||bytes.byteLength>256*1024*1024)throw new HttpError(413,'batch_input_too_large');
  const query=new URLSearchParams({uploadType:'media',name:this.#path(this.#input)});
  const response=await this.#request(`/upload/storage/v1/b/${encodeURIComponent(this.#bucket)}/o?${query}`,'POST',signal,bytes);await response.body?.cancel().catch(()=>{});return this.#input;
 }
 async #page(path:string,signal:AbortSignal):Promise<Record<string,unknown>>{
  const response=await this.#request(path,'GET',signal),reader=response.body?.getReader();if(!reader)throw new HttpError(502,'invalid_vertex_gcs_response');
  try{
   const chunks:Uint8Array[]=[];let size=0;for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>1024*1024)throw Error('limit');chunks.push(chunk.value);}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   const value=JSON.parse(new TextDecoder().decode(bytes));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('shape');return value;
  }catch{throw new HttpError(502,'invalid_vertex_gcs_response');}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 }
 async listOutputs(signal:AbortSignal,jsonlOnly=true):Promise<string[]>{
  const prefix=this.#output.slice(('gs://'+this.#bucket+'/').length),objects=new Set<string>(),tokens=new Set<string>();let token='';
  for(;;){
   const query=new URLSearchParams({prefix,maxResults:'1000',...(token?{pageToken:token}:{})});
   const page=await this.#page(`/storage/v1/b/${encodeURIComponent(this.#bucket)}/o?${query}`,signal);
   if(page.items!==undefined&&!Array.isArray(page.items))throw new HttpError(502,'invalid_vertex_gcs_response');
   for(const item of (page.items??[]) as Record<string,unknown>[]){
    if(!item||typeof item.name!=='string')throw new HttpError(502,'invalid_vertex_gcs_response');
    const uri='gs://'+this.#bucket+'/'+item.name;this.#path(uri,true);if(!jsonlOnly||item.name.endsWith('.jsonl'))objects.add(uri);
   }
   if(page.nextPageToken===undefined||page.nextPageToken==='')break;
   if(typeof page.nextPageToken!=='string'||page.nextPageToken.length>8192||tokens.has(page.nextPageToken))throw new HttpError(502,'invalid_vertex_gcs_pagination');token=page.nextPageToken;tokens.add(token);
  }
  return [...objects].sort();
 }
 async openOutput(uri:string,signal:AbortSignal):Promise<Response>{
  const object=this.#path(uri,true);return this.#request(`/storage/v1/b/${encodeURIComponent(this.#bucket)}/o/${encodeURIComponent(object)}?alt=media`,'GET',signal);
 }
 async *resultChunks(signal:AbortSignal):AsyncGenerator<Uint8Array>{
  const objects=await this.listOutputs(signal);
  if(!objects.length)throw new HttpError(502,'VERTEX_RESULT_OBJECTS_MISSING');
  for(let index=0;index<objects.length;index++){
   if(index)yield new Uint8Array([10]);
   const response=await this.openOutput(objects[index],signal),reader=response.body?.getReader();
   if(!reader)throw new HttpError(502,'invalid_vertex_gcs_result');
   try{for(;;){const chunk=await reader.read();if(chunk.done)break;yield chunk.value;}}
   finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
 }
 async deleteObject(uri:string,signal:AbortSignal):Promise<void>{
  const object=this.#path(uri);const response=await this.#request(`/storage/v1/b/${encodeURIComponent(this.#bucket)}/o/${encodeURIComponent(object)}`,'DELETE',signal,undefined,true);await response.body?.cancel().catch(()=>{});
 }
 async deleteOutputs(signal:AbortSignal):Promise<void>{for(const uri of await this.listOutputs(signal,false))await this.deleteObject(uri,signal);}
}
