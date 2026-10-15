import {Database,HttpError} from './db.ts';
import {accountFetch} from './account_proxy.ts';
import {parseAccountCredentials} from './validation.ts';
import type {Account} from './accounts.ts';
import type {ApiKeyCredentials} from './gateway.ts';

type Item=Record<string,any>;
type BatchAccount=Account&{type?:string};
export type GeminiBatchInput={model:string;items:{custom_id:string;prompt:string;reference_images?:{id?:string;type?:string;mime_type:string;data?:string;file_uri?:string}[]}[]};
export type GeminiBatchStatus={name:string;raw_state:string;status:'queued'|'running'|'succeeded'|'failed'|'cancelled'|'expired';done:boolean;output_ref?:string;error_code?:string;requeue_after_seconds:number};
export class GeminiBatchRequestError extends HttpError{
 readonly uncertain:boolean;readonly upstreamStatus:number|null;
 constructor(status:number,code:string,uncertain=false,upstreamStatus:number|null=null){super(status,code);this.uncertain=uncertain;this.upstreamStatus=upstreamStatus;}
}
const origin='https://generativelanguage.googleapis.com',maxBytes=256*1024*1024;
function resource(value:unknown,kind:'files'|'batches'):string{
 if(typeof value!=='string'||!new RegExp('^'+kind+'/[A-Za-z0-9_.-]{1,200}$').test(value)||['.','..'].includes(value.split('/')[1]))throw new HttpError(502,'invalid_gemini_batch_resource');return value;
}
function modelName(value:unknown):string{
 const model=typeof value==='string'?value.trim().replace(/^models\//,''):'';
 if(!/^[A-Za-z0-9._-]{1,200}$/.test(model)||['.','..'].includes(model))throw new HttpError(400,'invalid_batch_model');return model;
}
// Input items have already been expanded by the public batch request validator.
export function buildGeminiBatchJSONL(input:GeminiBatchInput):Uint8Array{
 modelName(input.model);
 if(!Array.isArray(input.items)||!input.items.length)throw new HttpError(400,'invalid_batch_items');
 const seen=new Set<string>(),lines:string[]=[];let size=0;
 for(const item of input.items){
  const id=typeof item?.custom_id==='string'?item.custom_id.trim():'',prompt=typeof item?.prompt==='string'?item.prompt.trim():'';
  if(!id||!prompt||seen.has(id))throw new HttpError(400,'invalid_batch_items');seen.add(id);
  const parts:Item[]=[{text:prompt}];
  if(item.reference_images!==undefined&&!Array.isArray(item.reference_images))throw new HttpError(400,'invalid_batch_reference');
  for(const ref of item.reference_images??[]){
   const mime=typeof ref?.mime_type==='string'?ref.mime_type.trim().toLowerCase().replace(/^image\/jpg$/,'image/jpeg'):'';
   if(!['image/png','image/jpeg','image/webp'].includes(mime)||ref.data!==undefined&&typeof ref.data!=='string'||ref.file_uri!==undefined&&typeof ref.file_uri!=='string')throw new HttpError(400,'invalid_batch_reference');
   const data=ref.data??'',uri=ref.file_uri?.trim()??'';
   if(Boolean(data)===Boolean(uri))throw new HttpError(400,'invalid_batch_reference');
   if(data){
    if(data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))throw new HttpError(400,'invalid_batch_reference');
    parts.push({inlineData:{mimeType:mime,data}});
   }else{if(!/^gs:\/\/[^/\s]+\/[^\r\n]+$/.test(uri))throw new HttpError(400,'invalid_batch_reference');parts.push({fileData:{mimeType:mime,fileUri:uri}});}
  }
  const line=JSON.stringify({key:id,request:{contents:[{parts}],generationConfig:{responseModalities:['TEXT','IMAGE']}}})+'\n';
  size+=new TextEncoder().encode(line).length;if(size>maxBytes)throw new HttpError(413,'batch_input_too_large');lines.push(line);
 }
 return new TextEncoder().encode(lines.join(''));
}
async function metadata(response:Response):Promise<Item>{
 const reader=response.body?.getReader();if(!reader)throw new HttpError(502,'invalid_gemini_batch_response');
 const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>1024*1024)throw new HttpError(502,'invalid_gemini_batch_response');chunks.push(chunk.value);}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 let value:unknown;try{value=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new HttpError(502,'invalid_gemini_batch_response');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(502,'invalid_gemini_batch_response');return value as Item;
}
export function geminiBatchStatus(batch:Item):GeminiBatchStatus{
 if(!batch||typeof batch!=='object'||Array.isArray(batch))throw new HttpError(502,'invalid_gemini_batch_response');
 for(const key of ['dest','response','error'])if(batch[key]!==undefined&&batch[key]!==null&&(typeof batch[key]!=='object'||Array.isArray(batch[key])))throw new HttpError(502,'invalid_gemini_batch_response');
 if(batch.state!==undefined&&typeof batch.state!=='string')throw new HttpError(502,'invalid_gemini_batch_response');
 const name=resource(batch.name,'batches'),raw=typeof batch.state==='string'?batch.state.trim():'';
 if(raw.length>100)throw new HttpError(502,'invalid_gemini_batch_response');
 const states:Record<string,GeminiBatchStatus['status']>={JOB_STATE_PENDING:'queued',JOB_STATE_QUEUED:'queued',JOB_STATE_RUNNING:'running',JOB_STATE_SUCCEEDED:'succeeded',JOB_STATE_FAILED:'failed',JOB_STATE_CANCELLED:'cancelled',JOB_STATE_EXPIRED:'expired'};
 let status=states[raw.toUpperCase()]??'running';
 if(!states[raw.toUpperCase()]&&batch.error&&(batch.error.message||batch.error.code))status='failed';
 const result:GeminiBatchStatus={name,raw_state:raw,status,done:!['queued','running'].includes(status),requeue_after_seconds:30};
 if(status==='succeeded'){
  for(const inline of [batch.response?.inlinedResponses,batch.response?.inlined_responses])if(inline!==undefined&&inline!==null&&!Array.isArray(inline))throw new HttpError(502,'invalid_gemini_batch_response');
  if([batch.response?.inlinedResponses,batch.response?.inlined_responses].some(value=>Array.isArray(value)&&value.length))throw new HttpError(502,'gemini_batch_inline_result_unsupported');
  const output=batch.dest?.fileName||batch.dest?.file_name||batch.response?.responsesFile||batch.response?.responses_file;
  if(output)result.output_ref=resource(output,'files');else{result.status='failed';result.error_code='GEMINI_RESULT_FILE_MISSING';}
 }else if(result.done)result.error_code='GEMINI_BATCH_'+status.toUpperCase();
 const providerCode=typeof batch.error?.code==='string'?batch.error.code.trim():typeof batch.error?.status==='string'?batch.error.status.trim():'';
 if(/^[A-Z][A-Z0-9_]{0,99}$/.test(providerCode))result.error_code=providerCode;
 return result;
}

export class GeminiBatchClient{
 readonly #db:Database;readonly #account:BatchAccount;readonly #apiKey:string;readonly #maxResultBytes:number;
 constructor(db:Database,account:BatchAccount,credentials:ApiKeyCredentials,options:{maxResultBytes?:number}={}){
  const resultLimit=options.maxResultBytes??0;if(!Number.isSafeInteger(resultLimit)||resultLimit<0)throw new HttpError(500,'invalid_batch_result_limit');this.#maxResultBytes=resultLimit;
  if(account.platform!=='gemini'||account.type!=='apikey')throw new HttpError(400,'batch_provider_account_unsupported');
  const {model_mapping:_,...authentication}=credentials as ApiKeyCredentials&{model_mapping?:unknown};
  const validated=parseAccountCredentials(authentication,'gemini','apikey') as ApiKeyCredentials;
  if(validated.base_url&&validated.base_url!==origin)throw new HttpError(400,'invalid_batch_provider_origin');
  this.#db=db;this.#account=account;this.#apiKey=validated.api_key;
 }
 private async request(path:string,method:string,signal:AbortSignal,body?:BodyInit,contentType?:string):Promise<Response>{
  const headers=new Headers({'x-goog-api-key':this.#apiKey});if(contentType)headers.set('content-type',contentType);
  let response:Response;
  try{response=await accountFetch(this.#db,this.#account,path.startsWith('https:')?path:origin+path,{method,headers,body,signal,redirect:'error'});}
  catch{throw new GeminiBatchRequestError(502,'gemini_batch_transport_failed',method==='POST');}
  if(!response.ok){
   const status=response.status;await response.body?.cancel();
   throw new GeminiBatchRequestError(502,[401,403].includes(status)?'gemini_batch_auth_failed':status===429?'gemini_batch_rate_limited':status===404?'gemini_batch_not_found':'gemini_batch_request_failed',method==='POST'&&(status>=500||status===408||status<400),status);
  }
  return response;
 }
 async uploadJSONL(bytes:Uint8Array,displayName:string,signal:AbortSignal):Promise<string>{
  if(!bytes.length||bytes.length>maxBytes||typeof displayName!=='string'||displayName.length>255)throw new HttpError(400,'invalid_batch_input');
  const boundary='s2a-'+crypto.randomUUID();
  const start=new TextEncoder().encode('--'+boundary+'\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json; charset=utf-8\r\n\r\n'+JSON.stringify({file:{displayName,mimeType:'application/jsonl'}})+'\r\n--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="batch.jsonl"\r\nContent-Type: application/jsonl\r\n\r\n');
  const body=new Blob([start,bytes as BlobPart,'\r\n--'+boundary+'--\r\n']);
  const response=await this.request('/upload/v1beta/files?uploadType=multipart','POST',signal,body,'multipart/form-data; boundary='+boundary);
  try{const value=await metadata(response);return resource(value.file?.name??value.name,'files');}
  catch{throw new GeminiBatchRequestError(502,'invalid_gemini_batch_response',true,response.status);}
 }
 async createBatch(model:string,file:string,displayName:string,signal:AbortSignal):Promise<GeminiBatchStatus>{
  if(typeof displayName!=='string'||displayName.length>255)throw new HttpError(400,'invalid_batch_input');
  const response=await this.request('/v1beta/models/'+encodeURIComponent(modelName(model))+':batchGenerateContent','POST',signal,JSON.stringify({batch:{displayName,inputConfig:{fileName:resource(file,'files')}}}),'application/json');
  try{return geminiBatchStatus(await metadata(response));}
  catch{throw new GeminiBatchRequestError(502,'invalid_gemini_batch_response',true,response.status);}
 }
 async getBatch(name:string,signal:AbortSignal):Promise<GeminiBatchStatus>{
  const expected=resource(name,'batches'),value=await metadata(await this.request('/v1beta/'+expected,'GET',signal));
  if(value.name!==expected)throw new HttpError(502,'invalid_gemini_batch_response');return geminiBatchStatus(value);
 }
 async cancelBatch(name:string,signal:AbortSignal):Promise<void>{await (await this.request('/v1beta/'+resource(name,'batches')+':cancel','POST',signal)).body?.cancel();}
 async deleteFile(name:string,signal:AbortSignal):Promise<void>{
  try{await (await this.request('/v1beta/'+resource(name,'files'),'DELETE',signal)).body?.cancel();}catch(error){if(!(error instanceof GeminiBatchRequestError&&error.upstreamStatus===404))throw error;}
 }
 async downloadFile(name:string,signal:AbortSignal):Promise<Response>{
  const ref=resource(name,'files'),info=await metadata(await this.request('/v1beta/'+ref,'GET',signal));
  if(info.downloadUri!==undefined&&typeof info.downloadUri!=='string'||info.download_url!==undefined&&typeof info.download_url!=='string'||info.name!==undefined&&info.name!==ref)throw new HttpError(502,'invalid_gemini_batch_response');
  const raw=[info.downloadUri,info.download_url].find(value=>typeof value==='string'&&value.trim())?.trim()??origin+'/v1beta/'+ref+':download';let target:URL;
  try{target=new URL(raw);}catch{throw new HttpError(502,'invalid_gemini_batch_download');}
  if(target.protocol!=='https:'||target.username||target.password||target.hash||target.port&&target.port!=='443'||!(target.hostname==='googleapis.com'||target.hostname.endsWith('.googleapis.com')))throw new HttpError(502,'invalid_gemini_batch_download');
  const response=await this.request(target.href,'GET',signal);
  if(!response.body)throw new HttpError(502,'invalid_gemini_batch_response');
  const length=response.headers.get('content-length');if(length&&/^\d+$/.test(length)&&this.#maxResultBytes>0&&Number(length)>this.#maxResultBytes){await response.body.cancel();throw new HttpError(502,'batch_result_too_large');}
  const resultLimit=this.#maxResultBytes;
  let size=0;const body=resultLimit>0?response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){size+=chunk.length;if(size>resultLimit)throw new HttpError(502,'batch_result_too_large');controller.enqueue(chunk);}})):response.body;
  const contentType=response.headers.get('content-type')||info.mimeType||'application/octet-stream';
  if(typeof contentType!=='string'||contentType.length>512||/[\r\n\x00]/.test(contentType)){await response.body.cancel();throw new HttpError(502,'invalid_gemini_batch_response');}
  const headers=new Headers({'content-type':contentType,'cache-control':'no-store'});
  return new Response(body,{status:response.status,headers});
 }
}
