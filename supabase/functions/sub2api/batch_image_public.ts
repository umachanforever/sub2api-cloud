import {HttpError} from './db.ts';
type Row=Record<string,any>;
function timestamp(value:unknown):number|null{
 if(value===undefined||value===null)return null;
 const time=typeof value==='number'?value*1000:typeof value==='string'?Date.parse(value):NaN;
 if(!Number.isFinite(time))throw new HttpError(503,'invalid_batch_timestamp');return Math.floor(time/1000);
}
export function publicBatchImage(row:Row):Row{
 const status=['created','uploading','submitted'].includes(row.status)?'queued':row.status==='indexing'?'processing_results':row.status;
 return {id:row.id,object:'image.batch',task_name:row.task_name??'',status,model:row.model,provider:row.provider,
  item_count:row.item_count??0,success_count:row.success_count??0,fail_count:row.fail_count??0,
  estimated_cost:row.estimated_cost??0,hold_amount:row.hold_amount??0,actual_cost:row.actual_cost??null,
  created_at:timestamp(row.created_at),submitted_at:timestamp(row.submitted_at),settled_at:timestamp(row.settled_at),
  ...(typeof row.output_deletion_pending==='boolean'?{output_deletion_pending:row.output_deletion_pending}:{}),
  ...(row.parent_batch_id?{parent_batch_id:row.parent_batch_id}:{}),
  ...(row.downloaded_at?{downloaded_at:timestamp(row.downloaded_at)}:{}),
  ...(row.output_deleted_at?{output_deleted_at:timestamp(row.output_deleted_at)}:{}),
 };
}
export function publicBatchImageItem(row:Row):Row{
 const success=row.status==='success',pending=row.status==='pending',code=typeof row.error_code==='string'&&/^[A-Z][A-Z0-9_]{0,99}$/.test(row.error_code)?row.error_code:'PROVIDER_ITEM_FAILED';
 return {custom_id:row.custom_id,status:success?'succeeded':pending?'pending':'failed',mime_type:row.mime_type??null,file_extension:row.file_extension??null,image_count:row.image_count??0,
  error:success||pending?null:{code,message:code},...(row.prompt_preview?{prompt_preview:row.prompt_preview}:{})};
}
