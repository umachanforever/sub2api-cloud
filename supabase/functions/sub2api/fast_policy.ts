import {HttpError} from './db.ts';
type Rule={service_tier?:string;action?:string;scope?:string;user_ids?:Array<string|number>;error_message?:string;model_whitelist?:string[];fallback_action?:string;fallback_error_message?:string};
export type FastPolicyContext={user_id:string;force_priority:boolean;settings?:{rules?:Rule[]}};
// Preserve original user-first, configured-order rule resolution and missing-tier opt-in.
export function applyFastPolicy(body:Record<string,unknown>,context:FastPolicyContext|undefined,account:{platform?:string;type?:string},model:string):void{
 if(!context||account.platform!=='openai')return;
 if(context.force_priority)body.service_tier='priority';
 if(body.service_tier!==undefined&&body.service_tier!==null&&typeof body.service_tier!=='string')return;
 const isOAuth=['oauth','setup-token'].includes(account.type??'');
 let tier=typeof body.service_tier==='string'?body.service_tier.trim().toLowerCase():'';
 if(tier==='fast')tier='priority';
 if(tier&&!['priority','flex','auto','default','scale','ultrafast'].includes(tier))return;
 const rules=context.settings?.rules;
 if(!Array.isArray(rules)){if(tier)body.service_tier=tier;return;}
 let action='pass',message='';
 outer:for(const scoped of [true,false])for(const rule of rules){
  if(!rule||typeof rule!=='object')continue;
  const users=Array.isArray(rule.user_ids)?rule.user_ids:[];
  if((users.length>0)!==scoped||users.length&&!users.some(id=>String(id)===context.user_id))continue;
  if(rule.scope==='oauth'&&!isOAuth||rule.scope==='apikey'&&(isOAuth||account.type==='bedrock')||rule.scope==='bedrock'&&account.type!=='bedrock')continue;
  const matchTier=typeof rule.service_tier==='string'?rule.service_tier.trim().toLowerCase():'';
  if(!tier?matchTier!=='missing':matchTier!==''&&matchTier!=='all'&&matchTier!==tier)continue;
  const patterns=Array.isArray(rule.model_whitelist)?rule.model_whitelist:[];
  const matches=!patterns.length||patterns.some(pattern=>typeof pattern==='string'&&(pattern===model||pattern.endsWith('*')&&model.startsWith(pattern.slice(0,-1))));
  action=(matches?rule.action:rule.fallback_action)||'pass';
  message=(matches?rule.error_message:rule.fallback_error_message)||'';
  break outer;
 }
 if(!tier){if(action==='force_priority')body.service_tier='priority';return;}
 if(action==='block')throw new HttpError(403,'permission_error',message||`openai service_tier=${tier} is not allowed for model ${model}`);
 if(action==='filter')delete body.service_tier;
 else if(action==='force_priority')body.service_tier='priority';
 else body.service_tier=tier;
}
