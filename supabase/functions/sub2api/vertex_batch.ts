import {HttpError} from './db.ts';
import {buildGeminiBatchJSONL} from './gemini_batch.ts';
import type {GeminiBatchInput,GeminiBatchStatus} from './gemini_batch.ts';

type ObjectValue=Record<string,unknown>;
function object(value:unknown):ObjectValue{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(502,'invalid_vertex_batch_response');
 return value as ObjectValue;
}
function segment(value:string,kind:string):string{
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw new HttpError(400,'invalid_vertex_'+kind);return value;
}
export function vertexBatchEndpoint(project:string,location='global'):string{
 segment(project,'project');segment(location,'location');
 const host=location==='global'?'aiplatform.googleapis.com':location+'-aiplatform.googleapis.com';
 return `https://${host}/v1/projects/${project}/locations/${location}/batchPredictionJobs`;
}
export function vertexBatchResource(value:unknown):string{
 if(typeof value!=='string'||!/^projects\/[A-Za-z0-9_-]{1,128}\/locations\/[A-Za-z0-9_-]{1,128}\/batchPredictionJobs\/[A-Za-z0-9_-]{1,200}$/.test(value))throw new HttpError(502,'invalid_vertex_batch_resource');return value;
}
function gcs(value:string):string{
 if(!/^gs:\/\/[a-z0-9][a-z0-9._-]{1,221}[a-z0-9]\/(?!$)[^\s\u0000-\u001f?#]+$/.test(value))throw new HttpError(400,'invalid_vertex_gcs_uri');
 if(value.slice(5).split('/').some(part=>part==='.'||part==='..'))throw new HttpError(400,'invalid_vertex_gcs_uri');return value;
}
export function vertexBatchManagedRefs(bucket:string,batchID:string,environment='production'):{input:string;output:string}{
 if(!/^[a-z0-9][a-z0-9._-]{1,221}[a-z0-9]$/.test(bucket))throw new HttpError(400,'invalid_vertex_gcs_bucket');
 if(!/^imgbatch_[A-Za-z0-9_-]{1,128}$/.test(batchID))throw new HttpError(400,'invalid_batch_id');
 segment(environment,'environment');
 const base=gcs(`gs://${bucket}/batch-image/${environment}/${batchID}/`);
 return {input:base+'input/requests.jsonl',output:base+'output/'};
}
export function buildVertexBatchJSONL(input:GeminiBatchInput):Uint8Array{
 // Vertex requires a user role in each native JSONL instance.
 const lines=new TextDecoder().decode(buildGeminiBatchJSONL(input)).trimEnd().split('\n');
 return new TextEncoder().encode(lines.map(line=>{
  const item=JSON.parse(line);item.request.contents[0].role='user';return JSON.stringify(item);
 }).join('\n')+'\n');
}
export function vertexBatchCreateRequest(model:string,input:string,output:string,displayName:string):ObjectValue{
 const normalized=model.trim().replace(/^\/+|\/+$/g,'');
 if(!/^(?:(?:projects\/[A-Za-z0-9_-]+\/locations\/[A-Za-z0-9_-]+\/)?publishers\/[A-Za-z0-9_-]+\/models\/)?[A-Za-z0-9._-]{1,200}$/.test(normalized)||['.','..'].includes(normalized))throw new HttpError(400,'invalid_batch_model');
 if(!displayName.trim()||new TextEncoder().encode(displayName).length>255||/[\u0000-\u001f]/.test(displayName))throw new HttpError(400,'invalid_batch_display_name');
 return {displayName,model:(normalized.startsWith('publishers/')||normalized.startsWith('projects/'))?normalized:'publishers/google/models/'+normalized,inputConfig:{instancesFormat:'jsonl',gcsSource:{uris:[gcs(input)]}},outputConfig:{predictionsFormat:'jsonl',gcsDestination:{outputUriPrefix:gcs(output)}},instanceConfig:{keyField:'key'}};
}
export function vertexBatchStatus(value:unknown,fallbackOutput?:string):GeminiBatchStatus{
 const job=object(value),name=vertexBatchResource(job.name);
 if(job.state!==undefined&&typeof job.state!=='string')throw new HttpError(502,'invalid_vertex_batch_response');
 const raw=typeof job.state==='string'?job.state.trim():'';
 if(raw.length>100)throw new HttpError(502,'invalid_vertex_batch_response');
 const states:Record<string,GeminiBatchStatus['status']>={JOB_STATE_PENDING:'queued',JOB_STATE_QUEUED:'queued',JOB_STATE_RUNNING:'running',JOB_STATE_PAUSED:'running',JOB_STATE_SUCCEEDED:'succeeded',JOB_STATE_FAILED:'failed',JOB_STATE_CANCELLED:'cancelled',JOB_STATE_EXPIRED:'expired'};
 let status=states[raw.toUpperCase()]??'running',errorCode:string|undefined;
 if(job.error!==undefined&&job.error!==null){
  const error=object(job.error);
  if(!states[raw.toUpperCase()]&&(error.message||error.code))status='failed';
  if(typeof error.status==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test(error.status))errorCode=error.status;
 }
 let output=fallbackOutput;
 if(job.outputConfig!==undefined&&job.outputConfig!==null){
  const config=object(job.outputConfig);
  if(config.gcsDestination!==undefined&&config.gcsDestination!==null){
   const destination=object(config.gcsDestination);
   if(destination.outputUriPrefix!==undefined){if(typeof destination.outputUriPrefix!=='string')throw new HttpError(502,'invalid_vertex_batch_response');output=destination.outputUriPrefix||output;}
  }
 }
 if(output){try{gcs(output);}catch{throw new HttpError(502,'invalid_vertex_batch_output');}}
 if(status==='succeeded'&&!output){status='failed';errorCode='VERTEX_RESULT_OBJECTS_MISSING';}
 const done=!['queued','running'].includes(status);
 if(!errorCode&&['failed','cancelled','expired'].includes(status))errorCode='VERTEX_BATCH_'+status.toUpperCase();
 return {name,raw_state:raw,status,done,...(output?{output_ref:output}:{}),...(errorCode?{error_code:errorCode}:{}),requeue_after_seconds:done?0:30};
}
