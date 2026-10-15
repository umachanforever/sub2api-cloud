import {HttpError} from './db.ts';
import {quotaWindowUpdates,type QuotaUsage} from './openai_quota_values.ts';

export type CreditCandidate={id:string;expires_at:string};
export function autoResetThreshold(value:unknown):number {
 const parsed=typeof value==='string' && value.trim()?Number(value):value;
 if(typeof parsed!=='number' || !Number.isFinite(parsed) || parsed<0.001 || parsed>1)throw new HttpError(400,'invalid_auto_reset_threshold');
 return parsed;
}
export function resetCreditCandidates(value:unknown):CreditCandidate[] {
 const row=value && typeof value==='object' && !Array.isArray(value)?value as Record<string,unknown>:{};
 const source=Array.isArray(value)?value:[row.credits,row.rate_limit_reset_credits,row.items,row.data].find(item=>item!=null);
 if(!Array.isArray(source) || source.length>1000)return [];
 const result:CreditCandidate[]=[];
 for(const entry of source){
  if(!entry || typeof entry!=='object' || Array.isArray(entry))continue;
  const type=String(entry.reset_type??entry.resetType??'').trim().toLowerCase(),status=String(entry.status??'').trim().toLowerCase();
  if((type && type!=='codex_rate_limits') || (status && status!=='available'))continue;
  const id=[entry.id,entry.credit_id,entry.creditId].find(value=>typeof value==='string' && value.trim()),expires=[entry.expires_at,entry.expiresAt].find(value=>typeof value==='string' && value.trim());
  if(typeof id!=='string' || id.length>512 || /[\x00-\x1f\x7f]/.test(id) || typeof expires!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(expires.trim()) || !Number.isFinite(Date.parse(expires)))throw new HttpError(409,'RESET_CREDIT_DETAILS_UNAVAILABLE');
  result.push({id:id.trim(),expires_at:new Date(expires).toISOString()});
 }
 return result;
}
export function resetAssessment(usage:QuotaUsage,extra:Record<string,unknown>) {
 const windows=quotaWindowUpdates(usage);
 const five=Number(windows.codex_5h_used_percent??0)>=autoResetThreshold(extra.auto_reset_credit_5h_threshold??1)*100;
 const seven=Number(windows.codex_7d_used_percent??0)>=autoResetThreshold(extra.auto_reset_credit_7d_threshold??1)*100;
 return {reached:five||seven,trigger_window:five&&seven?'5h+7d':five?'5h':seven?'7d':''};
}
export function resetCycle(usage:QuotaUsage):string {
 let five=0,seven=0;
 for(const window of [usage.rate_limit?.primary_window,usage.rate_limit?.secondary_window]){
  if(!window)continue;const at=window.reset_at>0?window.reset_at:usage.fetched_at+window.reset_after_seconds;
  if(window.limit_window_seconds<=21600)five=at;else seven=at;
 }
 return `5h:${five}|7d:${seven}`;
}
export async function resetHash(value:string) {
 const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
 return Array.from(digest.slice(0,12),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export async function selectResetCredit(candidates:CreditCandidate[],available:number,previous:Record<string,unknown>,cycleHash:string,now=Date.now()) {
 if(available<=0)throw new HttpError(409,'NO_RESET_CREDIT');
 const sorted=[...candidates].sort((a,b)=>Date.parse(a.expires_at)-Date.parse(b.expires_at));
 if(new Set(sorted.map(credit=>credit.id)).size<available)throw new HttpError(409,'RESET_CREDIT_DETAILS_UNAVAILABLE');
 if(previous.attempt_cycle_hash===cycleHash && previous.attempt_credit_hash){
  for(const credit of sorted)if(await resetHash(credit.id)===previous.attempt_credit_hash)return credit;
  throw new HttpError(409,'OPENAI_AUTO_RESET_ORIGINAL_CREDIT_UNAVAILABLE');
 }
 const credit=sorted[0];
 if(!credit || Date.parse(credit.expires_at)<=now)throw new HttpError(409,'OPENAI_AUTO_RESET_CREDIT_EXPIRY_INVALID');
 return credit;
}
