import {Database,HttpError} from './db.ts';
import {type Account,credentialsFor} from './accounts.ts';
import {decryptApiKeyCredentials,decryptSecret} from './credential_store.ts';
import {vertexGeminiRequest} from './vertex_gemini.ts';
import {apiKeyRequest} from './api_key_provider.ts';
import {accountFetch} from './account_proxy.ts';
import {readBody} from './validation.ts';
type Item=Record<string,any>;
export function estimateGeminiTokens(body:Item):number{
 let total=0;
 const count=(value:unknown)=>{
  if(typeof value!=='string'||!value.trim())return;
  let runes=0,ascii=0;for(const char of value.trim()){runes++;if((char.codePointAt(0)??0)<=127)ascii++;}
  total+=ascii/runes>=0.8?Math.ceil(runes/4):runes;
 };
 // Keep the native text-only fallback; provider counts remain authoritative for media.
 const list=(value:unknown):Item[]=>Array.isArray(value)?value:[];
 for(const part of list(body.systemInstruction?.parts))count(part?.text);
 for(const content of list(body.contents))for(const part of list(content?.parts))count(part?.text);
 return total;
}
export async function countGeminiTokens(db:Database,account:Account&{type?:string},path:string,body:Item,request:Request,signal:AbortSignal,onDispatch:()=>void,onResponse:()=>void):Promise<Item>{
 if(!['gemini','antigravity'].includes(account.platform??''))throw new HttpError(400,'gemini_group_required');
 const fallback=()=>({totalTokens:estimateGeminiTokens(body.generateContentRequest??body)});
 const apiKey=account.type==='apikey';
 const vertex=account.type==='service_account';
 let outgoing:ReturnType<typeof apiKeyRequest>;
 if(vertex){
  if(account.platform!=='gemini')throw new HttpError(400,'vertex_gemini_account_required');
  outgoing=await vertexGeminiRequest(await decryptSecret(account,db.config.encryptionKey),path,body,signal,(url,init)=>accountFetch(db,account,url,init));
 } else {
  const credentials=apiKey?await decryptApiKeyCredentials(account,db.config.encryptionKey):await credentialsFor(db,account);
  outgoing=apiKeyRequest('gemini',apiKey?credentials as {api_key:string}:{api_key:(credentials as {access_token:string}).access_token},'gemini',path,body,request,signal);
  if(!apiKey){const headers=new Headers(outgoing.init.headers);headers.delete('x-goog-api-key');headers.set('authorization','Bearer '+(credentials as {access_token:string}).access_token);outgoing.init.headers=headers;}
 }
 let response:Response;
 onDispatch();
 try{response=await accountFetch(db,account,outgoing.url,outgoing.init);}catch(error){
  if(error instanceof HttpError)throw error;
  if(signal.aborted)throw new HttpError(request.signal.aborted?499:504,'token_count_interrupted');
  return fallback();
 }
 onResponse();
 if(response.status===429||response.status>=500){await response.body?.cancel();return fallback();}
 if(!response.ok){
  let rejected:Item;try{rejected=await readBody(new Request('https://count.invalid',{method:'POST',body:response.body,duplex:'half'} as RequestInit),1048576);}catch{throw new HttpError(response.status>=400&&response.status<500?response.status:502,'token_count_upstream_failed');}
  const scope=response.headers.get('www-authenticate')??'';
  if(!apiKey&&response.status===403&&(/insufficient_scope/i.test(scope)||Array.isArray(rejected.error?.details)&&rejected.error.details.some((detail:Item)=>detail?.reason==='ACCESS_TOKEN_SCOPE_INSUFFICIENT')||/insufficient authentication scopes/i.test(rejected.error?.message??'')))return fallback();
  throw new HttpError(response.status>=400&&response.status<500?response.status:502,'token_count_upstream_failed');
 }
 let value:Item;
 try{value=await readBody(new Request('https://count.invalid',{method:'POST',body:response.body,duplex:'half'} as RequestInit),1048576);}catch{throw new HttpError(502,'invalid_token_count_response');}
 if(!Number.isSafeInteger(value.totalTokens)||value.totalTokens<0)throw new HttpError(502,'invalid_token_count_response');
 return value;
}
