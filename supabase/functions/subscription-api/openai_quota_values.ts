import { HttpError } from './db.ts';

type Fields=Record<string,unknown>;
export type QuotaWindow={used_percent:number;limit_window_seconds:number;reset_after_seconds:number;reset_at:number};
export type RateLimit={allowed:boolean;limit_reached:boolean;primary_window?:QuotaWindow|null;secondary_window?:QuotaWindow|null};
export type Credits={has_credits:boolean;unlimited:boolean;balance:string|null};
export type ResetCredits={available_count:number;credits?:{expires_at:string}[]};
export type QuotaUsage={user_id?:string;account_id?:string;email?:string;plan_type?:string;rate_limit?:RateLimit|null;additional_rate_limits?:{limit_name:string;metered_feature:string;rate_limit?:RateLimit|null}[];rate_limit_reset_credits?:ResetCredits|null;credits?:Credits|null;fetched_at:number};
const fail=()=>new HttpError(502,'invalid_openai_quota');
function fields(value:unknown):Fields {if(!value || typeof value!=='object' || Array.isArray(value))throw fail();return value as Fields;}
function text(value:unknown,max=512):string {if(typeof value!=='string' || value.length>max || /[\x00-\x1f\x7f]/.test(value))throw fail();return value;}
function number(value:unknown,integer=true,nonnegative=false):number {if(typeof value!=='number' || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) || (nonnegative && value<0))throw fail();return value;}
function boolean(value:unknown):boolean {if(typeof value!=='boolean')throw fail();return value;}
export function quotaWindow(value:unknown):QuotaWindow|null {
 if(value===null)return null;const row=fields(value);
 return {used_percent:number(row.used_percent,false,true),limit_window_seconds:number(row.limit_window_seconds,true,true),reset_after_seconds:number(row.reset_after_seconds),reset_at:number(row.reset_at,true,true)};
}
export function rateLimit(value:unknown):RateLimit|null {
 if(value===null)return null;const row=fields(value),result:RateLimit={allowed:boolean(row.allowed),limit_reached:boolean(row.limit_reached)};
 if(row.primary_window!==undefined)result.primary_window=quotaWindow(row.primary_window);
 if(row.secondary_window!==undefined)result.secondary_window=quotaWindow(row.secondary_window);
 return result;
}
export function codexCredits(value:unknown):Credits|null {
 if(value===null)return null;const row=fields(value);
 if(row.balance!==undefined && row.balance!==null && (typeof row.balance!=='string' || row.balance.length>100 || !/^-?\d+(?:\.\d+)?$/.test(row.balance)))throw fail();
 return {has_credits:boolean(row.has_credits),unlimited:boolean(row.unlimited),balance:(row.balance??null) as string|null};
}
function expiry(value:unknown):string {const date=text(value,64).trim();if(!date || !Number.isFinite(Date.parse(date)))throw fail();return date;}
function count(value:unknown):number|undefined {
 const parsed=typeof value==='string' && /^\d+$/.test(value.trim())?Number(value.trim()):value;
 return typeof parsed==='number' && Number.isSafeInteger(parsed) && parsed>=0 && parsed<=1000000?parsed:undefined;
}
export function resetCredits(value:unknown):ResetCredits|null {
 if(value===null)return null;const row=fields(value),available=count(row.available_count);
 if(available===undefined)throw fail();
 const result:ResetCredits={available_count:available};
 if(row.credits!==undefined && row.credits!==null){if(!Array.isArray(row.credits) || row.credits.length>1000)throw fail();result.credits=row.credits.map(item=>({expires_at:expiry(fields(item).expires_at)}));}
 return result;
}
export function quotaUsage(value:unknown,now=Math.floor(Date.now()/1000)):QuotaUsage {
 const row=fields(value),result:QuotaUsage={fetched_at:now};
 for(const key of ['user_id','account_id','email','plan_type'] as const)if(row[key]!==undefined && row[key]!==null)result[key]=text(row[key]);
 if(row.rate_limit!==undefined)result.rate_limit=rateLimit(row.rate_limit);
 if(row.credits!==undefined)result.credits=codexCredits(row.credits);
 if(row.rate_limit_reset_credits!==undefined)result.rate_limit_reset_credits=resetCredits(row.rate_limit_reset_credits);
 if(row.additional_rate_limits!==undefined && row.additional_rate_limits!==null){
  if(!Array.isArray(row.additional_rate_limits) || row.additional_rate_limits.length>1000)throw fail();
  result.additional_rate_limits=row.additional_rate_limits.map(item=>{const entry=fields(item);return {limit_name:entry.limit_name==null?'':text(entry.limit_name),metered_feature:entry.metered_feature==null?'':text(entry.metered_feature),...(entry.rate_limit===undefined?{}:{rate_limit:rateLimit(entry.rate_limit)})};});
 }
 return result;
}

export function resetCreditDetails(value:unknown):{available_count?:number;credits?:{expires_at:string}[]} {
 const row=Array.isArray(value)?{}:fields(value);
 const available=count(row.available_count)??count(row.availableCount);
 const source=Array.isArray(value)?value:[row.credits,row.rate_limit_reset_credits,row.items,row.data].find(item=>item!==undefined && item!==null);
 if(source===undefined)return available===undefined?{}:{available_count:available};
 if(!Array.isArray(source) || source.length>1000)return available===undefined?{}:{available_count:available};
 let availableEntries=0;const credits:{expires_at:string}[]=[];
 for(const item of source) {
  if(!item || typeof item!=='object' || Array.isArray(item))continue;const entry=item as Fields;
  const type=typeof (entry.reset_type??entry.resetType)==='string'?String(entry.reset_type??entry.resetType).trim().toLowerCase():'';
  const status=typeof entry.status==='string'?entry.status.trim().toLowerCase():'';
  if((type && type!=='codex_rate_limits') || (status && status!=='available'))continue;
  availableEntries++;
  try {credits.push({expires_at:expiry(entry.expires_at??entry.expiresAt)});} catch { /* Counts remain usable when expiration metadata is absent. */ }
 }
 return {available_count:available??availableEntries,credits};
}
export function completeResetCredits(value:ResetCredits|null|undefined):value is ResetCredits {
 return !!value && (value.available_count===0 || (value.credits?.length??0)>=value.available_count);
}
export function quotaDisplaySnapshot(name:string,value:unknown) {
 try {
  if(name==='codex_reset_credit_snapshot')return resetCredits(value);
  const row=fields(value);return {credits:codexCredits(row.credits),fetched_at:number(row.fetched_at,true,true)};
 }catch {throw new HttpError(400,'invalid_codex_quota_snapshot');}
}

export type QuotaResetResult={code:string;windows_reset:number;credit?:Record<string,string>|null};
export function quotaResetResult(value:unknown):QuotaResetResult {
 const row=fields(value),code=text(row.code,64),windows=number(row.windows_reset,true,true);
 if(!/^[a-z][a-z0-9_]{0,63}$/.test(code) || windows>1000000)throw fail();
 const result:QuotaResetResult={code,windows_reset:windows,credit:null};
 if(row.credit!==undefined){
  if(row.credit===null)result.credit=null;
  else {const source=fields(row.credit),credit:Record<string,string>={};for(const key of ['id','reset_type','status','granted_at','expires_at','redeem_started_at','redeemed_at'])if(source[key]!=null)credit[key]=text(source[key]);result.credit=credit;}
 }
 return result;
}

export function quotaWindowUpdates(usage:QuotaUsage):Record<string,number|string> {
 const rate=usage.rate_limit;if(!rate)return {};
 const primary=rate.primary_window,secondary=rate.secondary_window;
 const primaryMinutes=primary?Math.floor(primary.limit_window_seconds/60):null,secondaryMinutes=secondary?Math.floor(secondary.limit_window_seconds/60):null;
 const primaryIsShort=primaryMinutes!==null && secondaryMinutes!==null?primaryMinutes<secondaryMinutes:primaryMinutes!==null?primaryMinutes<=360:secondaryMinutes!==null?secondaryMinutes>360:false;
 const result:Record<string,number|string>={};
 for(const [name,window] of [['5h',primaryIsShort?primary:secondary],['7d',primaryIsShort?secondary:primary]] as const){
  if(!window)continue;
  result[`codex_${name}_used_percent`]=window.used_percent;
  result[`codex_${name}_reset_after_seconds`]=window.reset_after_seconds;
  result[`codex_${name}_window_minutes`]=Math.floor(window.limit_window_seconds/60);
  const date=new Date((usage.fetched_at+Math.max(0,window.reset_after_seconds))*1000);
  if(Number.isFinite(date.getTime()))result[`codex_${name}_reset_at`]=date.toISOString();
 }
 if(Object.keys(result).length)result.codex_usage_updated_at=new Date(usage.fetched_at*1000).toISOString();
 return result;
}
export function quotaWindowMetadata(name:string,value:unknown):number|string {
 try {
  if(name.endsWith('_at'))return expiry(value);
  return number(value,name.endsWith('_used_percent')?false:true,!name.endsWith('_reset_after_seconds'));
 }catch {throw new HttpError(400,'invalid_codex_quota_snapshot');}
}
