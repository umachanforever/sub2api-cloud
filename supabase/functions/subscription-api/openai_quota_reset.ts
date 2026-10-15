import { accountFetch } from "./account_proxy.ts";
import { Database, HttpError } from './db.ts';
import { credentialsFor } from './accounts.ts';
import { catalogJSON } from './account_models.ts';
import { quotaHeaders, queryOpenAIQuota, type QuotaAccount } from './openai_quota.ts';
import { completeResetCredits, quotaResetResult, quotaWindowUpdates, type QuotaResetResult, type QuotaUsage } from './openai_quota_values.ts';

export type ResetResponse=QuotaResetResult & {quota:QuotaUsage|null;cache_refreshed:boolean;account_state_recovered:boolean;warning_code?:string};
type Operation={id:string;lease_id:string;consumed:QuotaResetResult|null;response?:ResetResponse;error?:string;status?:number;replayed?:boolean};

async function consume(account:QuotaAccount,id:string,db:Database,creditId?:string) {
 let credentials=await credentialsFor(db,account);
 const signal=AbortSignal.timeout(20_000);
 const send=()=>accountFetch(db,account,'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',{
  method:'POST',headers:quotaHeaders(credentials),body:JSON.stringify({redeem_request_id:id,...(creditId?{credit_id:creditId}:{})}),signal,redirect:'error',
 });
 let response:Response;
 try {response=await send();if(response.status===401){await response.body?.cancel();credentials=await credentialsFor(db,account,credentials.access_token);response=await send();}}
 catch(error){if(error instanceof HttpError)throw error;throw new HttpError(502,'openai_quota_reset_request_failed');}
 if(!response.ok){const status=response.status;await response.body?.cancel();throw new HttpError([401,403,429].includes(status)?status:502,'openai_quota_reset_upstream_error');}
 try{return quotaResetResult(await catalogJSON(response,false,8192));}catch {throw new HttpError(502,'invalid_quota_reset_result');}
}

async function postReset(result:QuotaResetResult,account:QuotaAccount,db:Database):Promise<ResetResponse> {
 const response:ResetResponse={...result,quota:null,cache_refreshed:false,account_state_recovered:false};
 try {
  const recovered=await db.rpc<{error?:string}>('s2a_account_recover',{p_account_id:account.id,p_action:'recover-state'});
  if(recovered.error)throw new Error();response.account_state_recovered=true;
 }catch {response.warning_code='account_state_recovery_failed';return response;}
 try {
  const usage=await queryOpenAIQuota(new Request('https://gateway/quota'),account,db);
  const reset=completeResetCredits(usage.rate_limit_reset_credits)?usage.rate_limit_reset_credits:null;
  const saved=await db.rpc<boolean>('s2a_openai_quota_cache_save',{
   p_account_id:account.id,p_version:account.credential_version,p_fetched_at:usage.fetched_at,p_credits:usage.credits??null,p_reset_credits:reset,p_windows:quotaWindowUpdates(usage),
  });
  if(!saved || reset===null)throw new Error();response.quota=usage;response.cache_refreshed=true;
 }catch {response.warning_code='reset_credit_cache_refresh_failed';}
 return response;
}

export async function executeQuotaReset(account:QuotaAccount,actorId:string|null,key:string,db:Database,creditId?:string,job?:{revision:number;lease_id:string}) {
 const op=await db.rpc<Operation>('s2a_openai_quota_reset_begin',{p_account_id:account.id,p_actor_id:actorId,p_key:key,p_version:account.credential_version,...(creditId?{p_credit_id:creditId,p_job_revision:job?.revision,p_job_lease_id:job?.lease_id}:{})});
 if(op.error)throw new HttpError(op.status??503,op.error);
 let result=op.response;
 if(!result){
  let consumed=op.consumed;
  if(!consumed){
   if(!await db.rpc<boolean>('s2a_openai_quota_reset_dispatch',{p_id:op.id,p_lease_id:op.lease_id}))throw new HttpError(409,'quota_reset_lease_changed_retry');
   consumed=await consume(account,op.id,db,creditId);
   let recorded=false;
   try {recorded=await db.rpc<boolean>('s2a_openai_quota_reset_consumed',{p_id:op.id,p_lease_id:op.lease_id,p_result:consumed});}catch {console.warn('quota_reset_receipt_save_failed');}
   // A known consumption remains a success even if its durable receipt cannot be saved.
   if(!recorded)result={...consumed,quota:null,cache_refreshed:false,account_state_recovered:false,warning_code:'reset_credit_cache_refresh_failed'};
  }
  if(!result){
   result=creditId && consumed!.code==='no_credit'?{...consumed!,quota:null,cache_refreshed:false,account_state_recovered:false}:await postReset(consumed!,account,db);
   try {
    if(!await db.rpc<boolean>('s2a_openai_quota_reset_finish',{p_id:op.id,p_lease_id:op.lease_id,p_response:result}))console.warn('quota_reset_finish_not_saved');
   }catch {console.warn('quota_reset_finish_failed');}
  }
 }
 return {result,replayed:op.replayed===true};
}
