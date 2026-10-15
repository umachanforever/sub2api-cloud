import {HttpError} from './db.ts';
const tokenURL='https://oauth2.googleapis.com/token',scope='https://www.googleapis.com/auth/cloud-platform';
type Key={project_id:string;client_email:string;private_key:string;private_key_id?:string};
function parse(credentials:Record<string,unknown>):Key{
 let raw=credentials.service_account_json??credentials.service_account;
 if(typeof raw==='string'){try{raw=JSON.parse(raw);}catch{throw new HttpError(400,'invalid_vertex_credentials');}}
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new HttpError(400,'invalid_vertex_credentials');
 const value=raw as Record<string,unknown>;
 for(const name of ['project_id','client_email','private_key'])if(typeof value[name]!=='string'||!(value[name] as string).trim())throw new HttpError(400,'invalid_vertex_credentials');
 if(!/^[A-Za-z0-9_-]{1,128}$/.test(value.project_id as string)||!/^\S+@\S+$/.test(value.client_email as string)||(value.client_email as string).length>320)throw new HttpError(400,'invalid_vertex_credentials');
 if(value.private_key_id!==undefined&&(typeof value.private_key_id!=='string'||value.private_key_id.length>256||/[\u0000-\u001f]/.test(value.private_key_id)))throw new HttpError(400,'invalid_vertex_credentials');
 return {project_id:value.project_id as string,client_email:value.client_email as string,private_key:value.private_key as string,...(value.private_key_id?{private_key_id:value.private_key_id as string}:{})};
}
function encoded(bytes:Uint8Array):string{
 let value='';for(const byte of bytes)value+=String.fromCharCode(byte);return btoa(value).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}
const json=(value:unknown)=>encoded(new TextEncoder().encode(JSON.stringify(value)));
// Each instance is bound to one credential snapshot; replace it after credential rotation.
export class VertexServiceAccountToken{
 readonly project:string;#key:Key;#fetch:typeof fetch;#clock:()=>number;#cached?:{token:string;expires:number};#pending?:Promise<string>;
 constructor(credentials:Record<string,unknown>,fetcher:typeof fetch=fetch,clock:()=>number=Date.now){this.#key=parse(credentials);this.project=this.#key.project_id;this.#fetch=fetcher;this.#clock=clock;}
 async accessToken():Promise<string>{
  if(this.#cached&&this.#cached.expires>this.#clock()+60000)return this.#cached.token;
  if(this.#pending)return this.#pending;
  this.#pending=this.#exchange();try{return await this.#pending;}finally{this.#pending=undefined;}
 }
 async #exchange():Promise<string>{
  const key=this.#key,now=Math.floor(this.#clock()/1000);let assertion:string;
  try{
   const match=key.private_key.trim().match(/^-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+)\s*-----END PRIVATE KEY-----$/);
   if(!match)throw Error('invalid key');
   const bytes=Uint8Array.from(atob(match[1].replace(/\s/g,'')),c=>c.charCodeAt(0));
   const signing=await crypto.subtle.importKey('pkcs8',bytes,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
   const input=json({alg:'RS256',typ:'JWT',...(key.private_key_id?{kid:key.private_key_id}:{})})+'.'+json({iss:key.client_email,scope,aud:tokenURL,iat:now,exp:now+3600});
   assertion=input+'.'+encoded(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',signing,new TextEncoder().encode(input))));
  }catch{throw new HttpError(400,'invalid_vertex_private_key');}
  let response:Response;
  try{response=await this.#fetch(tokenURL,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});}
  catch{throw new HttpError(502,'vertex_token_exchange_failed');}
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw new HttpError(502,'vertex_token_exchange_failed');}
  const reader=response.body?.getReader();if(!reader)throw new HttpError(502,'invalid_vertex_token_response');
  let value:Record<string,unknown>;
  try{
   const chunks:Uint8Array[]=[];let size=0;for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>1024*1024)throw Error('limit');chunks.push(chunk.value);}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   value=JSON.parse(new TextDecoder().decode(bytes));
   if(!value||typeof value!=='object'||Array.isArray(value))throw Error('shape');
   if(typeof value.access_token!=='string'||!value.access_token||value.access_token.length>65536||/[\s\u0000-\u001f]/.test(value.access_token)||typeof value.expires_in!=='number'||!Number.isFinite(value.expires_in)||value.expires_in<=0||value.expires_in>86400||(value.token_type!==undefined&&String(value.token_type).toLowerCase()!=='bearer'))throw Error('token');
  }catch{throw new HttpError(502,'invalid_vertex_token_response');}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  // Count expiry from assertion creation, conservatively including network latency.
  this.#cached={token:value.access_token as string,expires:now*1000+(value.expires_in as number)*1000};return this.#cached.token;
 }
}
