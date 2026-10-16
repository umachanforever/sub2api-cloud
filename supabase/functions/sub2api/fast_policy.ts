import {HttpError} from './db.ts';
import {originalFastPolicy} from './original_chat_bridge.ts';
type Rule={service_tier?:string;action?:string;scope?:string;user_ids?:Array<string|number>;error_message?:string;model_whitelist?:string[];fallback_action?:string;fallback_error_message?:string};
export type FastPolicyContext={user_id:string;force_priority:boolean;settings?:{rules?:Rule[]};settings_json?:string|null};
// Preserve original user-first, configured-order rule resolution and missing-tier opt-in.
export async function applyFastPolicy(body:Record<string,unknown>,context:FastPolicyContext|undefined,account:{platform?:string;type?:string},model:string):Promise<void>{
 if(!context||account.platform!=='openai')return;
 if(context.force_priority)body.service_tier='priority';
 if(body.service_tier!==undefined&&body.service_tier!==null&&typeof body.service_tier!=='string')return;
 let tier=typeof body.service_tier==='string'?body.service_tier.trim().toLowerCase():'';
 if(tier==='fast')tier='priority';
 if(tier&&!['priority','flex','auto','default','scale','ultrafast'].includes(tier))return;
 const {action,message}=await originalFastPolicy({settings:context.settings,settings_json:context.settings_json,user_id:context.user_id,account_type:account.type,model,tier:tier||'missing'});
 if(!tier){if(action==='force_priority')body.service_tier='priority';return;}
 if(action==='block')throw new HttpError(403,'permission_error',message||`openai service_tier=${tier} is not allowed for model ${model}`);
 if(action==='filter')delete body.service_tier;
 else if(action==='force_priority')body.service_tier='priority';
 else body.service_tier=tier;
}
