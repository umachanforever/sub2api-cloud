import {Database,HttpError} from './db.ts';
import {json} from './http.ts';
import {authorizeJob} from './privacy_jobs.ts';
import {queryOpenAIQuota,type QuotaAccount} from './openai_quota.ts';
import {executeQuotaReset} from './openai_quota_reset.ts';
import {completeResetCredits,quotaWindowUpdates} from './openai_quota_values.ts';
import {resetAssessment,resetCycle,resetHash,selectResetCredit} from './openai_auto_reset_values.ts';

type Job={account_id:string;revision:number;lease_id:string};
type AutoAccount=QuotaAccount & {status:string;schedulable:boolean;extra:Record<string,unknown>};
type State={status:string;available_count:number;checked_at:string;trigger_window?:string;last_result_at?:string;error_code?:string;attempt_cycle_hash?:string;attempt_credit_hash?:string};
const fields='id,platform,type,ciphertext,iv,credential_version,proxy_id,status,schedulable,extra';
const eligible=(a:AutoAccount|undefined):a is AutoAccount=>!!a && a.platform==='openai' && a.type==='oauth' && a.status==='active' && a.schedulable && a.extra.auto_reset_credit_enabled===true;

export async function evaluateAutoReset(job:Job,db:Database) {
 let state:State={status:'checking',available_count:0,checked_at:new Date().toISOString()},delay=60;
 const write=()=>db.rpc<boolean>('s2a_openai_auto_reset_state',{p_account_id:job.account_id,p_revision:job.revision,p_lease_id:job.lease_id,p_state:state});
 const load=async()=> (await db.rest<AutoAccount[]>(`s2a_accounts?id=eq.${job.account_id}&select=${fields}`))[0];
 try {
  let account=await load();if(!eligible(account))return;
  const previous=account.extra.codex_auto_reset_credit_state as Record<string,unknown>|undefined??{};
  if(typeof previous.available_count==='number')state.available_count=previous.available_count;
  if(typeof previous.attempt_cycle_hash==='string')state.attempt_cycle_hash=previous.attempt_cycle_hash;
  if(typeof previous.attempt_credit_hash==='string')state.attempt_credit_hash=previous.attempt_credit_hash;
  if(!await write())return;
  const complete=(result:Awaited<ReturnType<typeof executeQuotaReset>>['result'])=>{
   state.last_result_at=new Date().toISOString();
   if(result.code==='no_credit'){state.status='no_credit';state.available_count=0;state.error_code='NO_RESET_CREDIT';delay=600;}
   else if(result.warning_code){state.status='failed';state.error_code=result.warning_code;}
   else {state.status='success';state.available_count=result.quota?.rate_limit_reset_credits?.available_count??Math.max(0,state.available_count-1);}
  };
  // The durable journal wins over changing card lists after an uncertain consumption.
  const pending=await db.rpc<{credit_id:string;key:string}|null>('s2a_openai_auto_reset_pending',{p_account_id:account.id});
  if(pending){state.status='resetting';if(!await write())return;complete((await executeQuotaReset(account,null,pending.key,db,pending.credit_id,job)).result);return;}
  let usage;
  try {usage=await queryOpenAIQuota(new Request('https://gateway/quota'),account,db,true);}
  catch {throw new HttpError(502,'RESET_CREDIT_QUERY_FAILED');}
  const {candidates=[],...publicUsage}=usage;
  const reset=completeResetCredits(usage.rate_limit_reset_credits)?usage.rate_limit_reset_credits:null;
  try {
   if(!await db.rpc<boolean>('s2a_openai_quota_cache_save',{p_account_id:account.id,p_version:account.credential_version,p_fetched_at:usage.fetched_at,p_credits:usage.credits??null,p_reset_credits:reset,p_windows:quotaWindowUpdates(usage)}))throw new Error();
  }catch {throw new HttpError(503,'USAGE_SNAPSHOT_WRITE_FAILED');}
  account=await load();if(!eligible(account))return;
  if(!usage.rate_limit_reset_credits)throw new HttpError(502,'RESET_CREDIT_DETAILS_UNAVAILABLE');
  const assessment=resetAssessment(publicUsage,account.extra),available=usage.rate_limit_reset_credits.available_count;
  state={...state,trigger_window:assessment.trigger_window,status:available>0?'available':'no_credit',available_count:available};
  if(!assessment.reached || available<=0){delay=600;if(assessment.reached && !available)state.error_code='NO_RESET_CREDIT';return;}
  const cycleHash=await resetHash(resetCycle(publicUsage)),credit=await selectResetCredit(candidates,available,previous,cycleHash);
  const creditHash=await resetHash(credit.id);
  state={...state,status:'resetting',attempt_cycle_hash:cycleHash,attempt_credit_hash:creditHash};
  if(!await write())return;
  const result=(await executeQuotaReset(account,null,`auto:${cycleHash}:${creditHash}`,db,credit.id,job)).result;
  complete(result);
 }catch(error){
  if(error instanceof HttpError && ['openai_quota_reset_in_progress','quota_reset_lease_changed_retry','auto_reset_disabled','quota_reset_target_conflict'].includes(error.code)){
   state.status='resetting';
  }else {state.status='failed';state.error_code=error instanceof HttpError?error.code:'OPENAI_AUTO_RESET_FAILED';state.last_result_at=new Date().toISOString();}
 }finally {
  try {await db.rpc('s2a_openai_auto_reset_finish',{p_account_id:job.account_id,p_revision:job.revision,p_lease_id:job.lease_id,p_state:state,p_delay:delay});}
  catch {console.warn('auto_reset_job_finish_failed');}
 }
}

export async function autoResetJobs(request:Request,db:Database) {
 await authorizeJob(request,db,'quota-reset');
 const jobs=await db.rpc<Job[]>('s2a_openai_auto_reset_claim',{});
 await Promise.all(jobs.map(job=>evaluateAutoReset(job,db)));
 return json(200,{claimed:jobs.length});
}
