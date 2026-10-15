import {HttpError} from './db.ts';

export function pauseThreshold(value:unknown):number {
 const parsed=typeof value==='string' && value.trim()?Number(value):value;
 if(typeof parsed!=='number' || !Number.isFinite(parsed) || parsed<0 || parsed>1)throw new HttpError(400,'invalid_quota_pause_threshold');
 return parsed;
}
export function quotaPauseSettings(value:unknown) {
 if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!['default_threshold_5h','default_threshold_7d'].includes(key)))throw new HttpError(400,'invalid_quota_pause_settings');
 const input=value as Record<string,unknown>;
 return {default_threshold_5h:pauseThreshold(input.default_threshold_5h??0),default_threshold_7d:pauseThreshold(input.default_threshold_7d??0)};
}

export function quotaHeaderWindows(headers:Headers,now=Math.floor(Date.now()/1000)):Record<string,number|string>|null {
 const read=(prefix:string,name:string,integer=false)=>{
  const value=headers.get(`x-codex-${prefix}-${name}`)?.trim();if(!value || value.length>64 || !/^-?\d+(?:\.\d+)?$/.test(value))return undefined;
  const parsed=Number(value);return Number.isFinite(parsed) && (!integer || Number.isSafeInteger(parsed))?parsed:undefined;
 };
 const primaryMinutes=read('primary','window-minutes',true),secondaryMinutes=read('secondary','window-minutes',true);
 const primaryShort=primaryMinutes!==undefined && secondaryMinutes!==undefined?primaryMinutes<secondaryMinutes:primaryMinutes!==undefined?primaryMinutes<=360:secondaryMinutes!==undefined?secondaryMinutes>360:false;
 const result:Record<string,number|string>={};
 for(const [prefix,name] of [['primary',primaryShort?'5h':'7d'],['secondary',primaryShort?'7d':'5h']]){
  const used=read(prefix,'used-percent'),minutes=read(prefix,'window-minutes',true),after=read(prefix,'reset-after-seconds',true);
  if(used!==undefined && used>=0)result[`codex_${name}_used_percent`]=used;
  if(minutes!==undefined && minutes>=0)result[`codex_${name}_window_minutes`]=minutes;
  if(after!==undefined){result[`codex_${name}_reset_after_seconds`]=after;const at=new Date((now+Math.max(0,after))*1000);if(Number.isFinite(at.getTime()))result[`codex_${name}_reset_at`]=at.toISOString();}
 }
 if(!Object.keys(result).length)return null;
 result.codex_usage_updated_at=new Date(now*1000).toISOString();return result;
}
