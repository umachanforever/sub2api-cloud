import { accountFetch } from "./account_proxy.ts";
import { Database, HttpError } from './db.ts';
import { credentialsFor, type Account } from './accounts.ts';
import { buildHeaders, type OAuthCredentials } from './gateway.ts';
import { catalogJSON } from './account_models.ts';
import { completeResetCredits, quotaUsage, quotaWindowUpdates, resetCreditDetails, type QuotaUsage } from './openai_quota_values.ts';
import { resetCreditCandidates, type CreditCandidate } from './openai_auto_reset_values.ts';

export type QuotaAccount=Account & {platform:string;type:string};
export function quotaHeaders(credentials:OAuthCredentials) {
 const headers=buildHeaders(credentials);
 headers.set('accept','application/json');headers.set('openai-beta','codex-1');headers.set('originator','Codex Desktop');headers.set('oai-language','zh-CN');
 headers.set('sec-fetch-site','none');headers.set('sec-fetch-mode','no-cors');headers.set('sec-fetch-dest','empty');headers.set('priority','u=4, i');
 return headers;
}
export async function queryOpenAIQuota(request:Request,account:QuotaAccount,db:Database,includeCandidates=false,includeCredits=true):Promise<QuotaUsage & {candidates?:CreditCandidate[]}> {
 let credentials=await credentialsFor(db,account);
 const signal=AbortSignal.any([request.signal,AbortSignal.timeout(20_000)]);
 const forward=(path:string)=>accountFetch(db,account,`https://chatgpt.com/backend-api/wham/${path}`,{method:'GET',headers:quotaHeaders(credentials),signal,redirect:'error'});
 let response:Response;
 try {
  response=await forward('usage');
  if(response.status===401){await response.body?.cancel();credentials=await credentialsFor(db,account,credentials.access_token);response=await forward('usage');}
 }catch(error){if(error instanceof HttpError)throw error;throw new HttpError(502,'openai_quota_request_failed');}
 if(!response.ok){const status=response.status;await response.body?.cancel();throw new HttpError([401,403,429].includes(status)?status:502,'openai_quota_upstream_error');}
 let usage:QuotaUsage & {candidates?:CreditCandidate[]};
 try {usage=quotaUsage(await catalogJSON(response,false,512*1024));}
 catch {throw new HttpError(502,'invalid_openai_quota');}
 if(!includeCredits)return usage;
 try {
  const detailsResponse=await forward('rate-limit-reset-credits');
  const raw=await catalogJSON(detailsResponse,true,512*1024),details=resetCreditDetails(raw);
  if(includeCandidates)usage.candidates=resetCreditCandidates(raw);
  if(details.available_count!==undefined || details.credits!==undefined)usage.rate_limit_reset_credits={
   available_count:details.available_count??usage.rate_limit_reset_credits?.available_count??0,
   ...(details.credits===undefined?{}:{credits:details.credits}),
  };
 }catch { /* Usage remains authoritative when the optional expiration endpoint is unavailable. */ }
 return usage;
}
