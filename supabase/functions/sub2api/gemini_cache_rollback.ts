import {Database,HttpError} from './db.ts';
import {type Account} from './accounts.ts';
import {apiKeyRequest} from './api_key_provider.ts';
import {accountFetch} from './account_proxy.ts';
import {readBody} from './validation.ts';
import type {ApiKeyCredentials} from './gateway.ts';

export async function rollbackGeminiCache(db:Database,account:Account,credentials:Record<string,unknown>,name:string,expiry:string,request:Request,signal:AbortSignal):Promise<boolean>{
 if(!/^cachedContents\/[a-zA-Z0-9_-]{1,480}$/.test(name)||!Number.isFinite(Date.parse(expiry)))throw new HttpError(503,'invalid_cache_recovery_state');
 if(account.platform!=='gemini'||typeof credentials.api_key!=='string')throw new HttpError(501,'cache_account_type_unsupported');
 const expired=Date.parse(expiry)<=Date.now()+1000;
 const outgoing=apiKeyRequest('gemini',credentials as ApiKeyCredentials,'gemini','/v1beta/'+name,undefined,request,signal);
 outgoing.init.method=expired?'DELETE':'PATCH';
 if(!expired){outgoing.url+='?updateMask=expireTime';outgoing.init.body=JSON.stringify({expireTime:expiry});}
 const response=await accountFetch(db,account,outgoing.url,outgoing.init);
 if((expired&&response.ok)||response.status===404){await response.body?.cancel();return true;}
 if(!response.ok){await response.body?.cancel();throw new HttpError(502,'cache_mutation_recovery_failed');}
 let restored:Record<string,unknown>;
 try{restored=await readBody(new Request('https://cache.invalid',{method:'POST',body:response.body,duplex:'half'} as RequestInit),1048576);}catch{throw new HttpError(502,'invalid_cache_recovery_response');}
 if(restored.name!==name||typeof restored.expireTime!=='string'||!Number.isFinite(Date.parse(restored.expireTime))||Math.abs(Date.parse(restored.expireTime)-Date.parse(expiry))>1000)throw new HttpError(502,'invalid_cache_recovery_response');
 return false;
}
