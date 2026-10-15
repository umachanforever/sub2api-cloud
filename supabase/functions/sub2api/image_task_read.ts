import {Database,HttpError} from './db.ts';
import {hashKey} from './validation.ts';
import {imageTaskRPC,imageTaskClientIP} from './image_task_submit.ts';
import {renderImageTask} from './image_task_result.ts';
import {json} from './http.ts';
export async function imageTaskRead(request:Request,id:string,token:string,db:Database):Promise<Response>{
 if(request.method!=='GET')throw new HttpError(405,'method_not_allowed');
 if(db.config.dataModel!=='native')throw new HttpError(501,'native_data_model_required');
 if(!/^imgtask_[a-f0-9]{32}$/.test(id))throw new HttpError(400,'invalid_image_task');
 const task=await imageTaskRPC(db,'s2a_personal_image_task_read',{p_key_hash:await hashKey(token),p_id:id,p_client_ip:imageTaskClientIP(request)},id);
 const response=json(200,await renderImageTask(db,task,request.signal));
 if(task.status==='processing')response.headers.set('retry-after','3');return response;
}
