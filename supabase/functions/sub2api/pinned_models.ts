import {completePinnedMetadata} from './pinned_model_metadata.ts';
import {type Account,credentialsFor} from './accounts.ts';
import {accountFetch} from './account_proxy.ts';
import {apiKeyRequest} from './api_key_provider.ts';
import {decryptApiKeyCredentials,decryptSecret} from './credential_store.ts';
import {currentCodexIdentity} from './codex_identity.ts';
import {codexCatalogDescriptor} from './codex_catalog.ts';
import {Database,HttpError} from './db.ts';
import {buildHeaders,CODEX_MODELS_URL,modelListFromManifest} from './gateway.ts';
import {mappedTarget} from './model_mapping.ts';
import {filterModelCatalog,type ModelAllowlist} from './model_policy.ts';
import {codexManifestResponse} from './model_catalog_response.ts';
import {json} from './http.ts';
type Entry=Record<string,any>;
type PinnedAccount=Account & {type:'oauth'|'apikey';platform:'openai';model_passthrough?:boolean;model_metadata?:unknown};
export type PinnedModelCatalog={accounts:PinnedAccount[];fallback_to_scheduler?:boolean;model_allowlist?:ModelAllowlist;error?:string;status?:number};

async function catalogBody(response:Response):Promise<Entry>{
 if(!response.ok){await response.body?.cancel();throw new HttpError(502,'pinned_model_upstream_failed');}
 if(!response.body)throw new HttpError(502,'invalid_pinned_model_catalog');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>32*1024*1024)throw new HttpError(502,'pinned_model_catalog_too_large');chunks.push(value);}
 }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 let value:unknown;try{value=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new HttpError(502,'invalid_pinned_model_catalog');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(502,'invalid_pinned_model_catalog');
 return value as Entry;
}
function entries(body:Entry,field:string,key:string):Entry[]{
 if(!Array.isArray(body[field]))throw new HttpError(502,'invalid_pinned_model_catalog');
 for(const entry of body[field])if(!entry||typeof entry!=='object'||Array.isArray(entry)||typeof entry[key]!=='string'||!entry[key].trim())throw new HttpError(502,'invalid_pinned_model_catalog');
 return body[field];
}
async function sourceCatalog(db:Database,account:PinnedAccount,request:Request,signal:AbortSignal,manifest:boolean,allowlist?:ModelAllowlist):Promise<Entry>{
 if(account.platform!=='openai'||!['oauth','apikey'].includes(account.type))throw new HttpError(503,'invalid_pinned_model_account');
 const incoming=new URL(request.url),clientVersion=incoming.searchParams.get('client_version');
 let body:Entry;
 if(account.type==='apikey'){
  const credentials=await decryptApiKeyCredentials(account,db.config.encryptionKey);
  const metadataMapping=(credentials as typeof credentials & {model_mapping?:Record<string,string>}).model_mapping??{};
  delete (credentials as typeof credentials & {model_mapping?:unknown}).model_mapping;
  const discoveryRequest=new Request(new URL('/v1/models',request.url));
  const outbound=apiKeyRequest('openai',credentials,'models','/v1/models',undefined,discoveryRequest,signal);
  if(manifest){
   const identity=await currentCodexIdentity(db,account,{access_token:''}),url=new URL(outbound.url);
   url.searchParams.set('client_version',clientVersion||identity.version);outbound.url=url.href;
   const headers=new Headers(outbound.init.headers);headers.set('version',identity.version);headers.set('user-agent',identity.userAgent);headers.set('originator',identity.originator);outbound.init.headers=headers;
  }
  body=await catalogBody(await accountFetch(db,account,outbound.url,outbound.init));
  if(manifest){
   const models=Array.isArray(body.models)?entries(body,'models','slug'):entries(body,'data','id').map(entry=>({...entry,slug:entry.id}));
   body={...body,models:models.flatMap(entry=>{const descriptor=codexCatalogDescriptor(entry.slug);return descriptor?[completePinnedMetadata(descriptor,entry,account.model_metadata,metadataMapping)]:[]})};
   delete body.data;
  }else if(Array.isArray(body.models)){body=modelListFromManifest(body);}else entries(body,'data','id');
 }else{
  let credentials=await credentialsFor(db,account);
  const identity=await currentCodexIdentity(db,account,credentials);
  const forward=()=>{const headers=buildHeaders(credentials,identity);headers.set('accept','application/json');return accountFetch(db,account,CODEX_MODELS_URL+'?client_version='+encodeURIComponent(clientVersion||identity.version),{method:'GET',headers,signal});};
  let response=await forward();
  if(response.status===401){await response.body?.cancel();credentials=await credentialsFor(db,account,credentials.access_token);response=await forward();}
  const raw=await catalogBody(response);entries(raw,'models','slug');body=manifest?raw:modelListFromManifest(raw);
 }
 const credentials=await decryptSecret(account,db.config.encryptionKey);
 const mapping=credentials.model_mapping;
 if(account.model_passthrough||!mapping||typeof mapping!=='object'||Array.isArray(mapping)||!Object.keys(mapping).length)return body;
 const field=manifest?'models':'data',key=manifest?'slug':'id',original=entries(body,field,key),byId=new Map(original.map(entry=>[entry[key].trim(),entry]));
 const candidates=[...byId.keys(),...Object.keys(mapping).sort(),...(allowlist?.enabled?allowlist.models:[])],seen=new Set<string>(),projected:Entry[]=[];
 for(const id of candidates){
  if(!id||id.includes('*')||seen.has(id))continue;
  const target=mappedTarget(mapping as Record<string,string>,id,'openai'),source=target?byId.get(target.trim()):undefined;
  if(!source||manifest&&!codexCatalogDescriptor(target!))continue;
  seen.add(id);projected.push(id===target?source:{...source,[key]:id,display_name:id});
 }
 return {...body,[field]:projected};
}

type CachedCatalog={until:number;body:Entry};
const catalogs=new WeakMap<Database,Map<string,CachedCatalog>>();
async function cachedSourceCatalog(db:Database,account:PinnedAccount,request:Request,signal:AbortSignal,manifest:boolean,allowlist?:ModelAllowlist):Promise<Entry>{
 // Hash the complete credential-bearing identity; never retain credentials in cache keys.
 const identity=JSON.stringify([account,new URL(request.url).searchParams.get('client_version'),manifest,allowlist]);
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(identity));
 const key=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
 let cache=catalogs.get(db);if(!cache){cache=new Map();catalogs.set(db,cache);}
 const cached=cache.get(key);if(cached&&cached.until>Date.now())return structuredClone(cached.body);
 cache.delete(key);
 const body=await sourceCatalog(db,account,request,signal,manifest,allowlist);
 if(signal.aborted)throw signal.reason;
 // Bound retained catalog text to at most 8 MiB per handler scope.
 if(JSON.stringify(body).length*2>256*1024)return body;
 if(cache.size>=32)cache.delete(cache.keys().next().value!);
 cache.set(key,{until:Date.now()+60000,body:structuredClone(body)});
 return body;
}

export async function pinnedModelCatalog(db:Database,catalog:PinnedModelCatalog,request:Request,signal:AbortSignal,modelId:string|undefined,manifest:boolean):Promise<Response|null>{
 if(!catalog||catalog.error)throw new HttpError(catalog?.status??503,catalog?.error??'invalid_pinned_model_catalog');
 if(!Array.isArray(catalog.accounts)||catalog.accounts.length>10)throw new HttpError(503,'invalid_pinned_model_catalog');
 // Promise.allSettled retains configuration order even when upstreams finish out of order.
 const results=await Promise.allSettled(catalog.accounts.map(account=>cachedSourceCatalog(db,account,request,signal,manifest&&!modelId,catalog.model_allowlist)));
 if(signal.aborted)throw signal.reason;
 const bodies=results.flatMap(result=>result.status==='fulfilled'?[result.value]:[]);
 if(!bodies.length){if(catalog.fallback_to_scheduler)return null;throw new HttpError(catalog.accounts.length?502:503,catalog.accounts.length?'pinned_model_upstream_failed':'no_available_pinned_account');}
 const field=manifest&&!modelId?'models':'data',key=field==='models'?'slug':'id',seen=new Set<string>(),merged:Entry[]=[];
 for(const body of bodies)for(const entry of entries(body,field,key)){const id=entry[key].trim();if(!seen.has(id)){seen.add(id);merged.push(entry);}}
 const value=filterModelCatalog(catalog.model_allowlist,{...bodies[0],[field]:merged});
 if(modelId){const model=value.data.find((entry:Entry)=>entry.id===modelId);if(!model)throw new HttpError(404,'model_not_found');return json(200,model);}
 return codexManifestResponse(value,request);
}
