import * as o200k from 'gpt-tokenizer/encoding/o200k_base';
import * as cl100k from 'gpt-tokenizer/encoding/cl100k_base';
import {type Account, credentialsFor} from './accounts.ts';
import {accountFetch} from './account_proxy.ts';
import {decryptApiKeyCredentials} from './credential_store.ts';
import {Database,HttpError} from './db.ts';
import type {Platform} from './gateway.ts';

export function inputTokenRequest(body:Record<string,unknown>):Record<string,unknown> {
  if(body.stream===true || body.instructions!==undefined&&typeof body.instructions!=='string' || body.tools!==undefined&&(!Array.isArray(body.tools)||body.tools.some(tool=>!tool||typeof tool!=='object'||Array.isArray(tool))))throw new HttpError(400,'invalid_request');
  return Object.fromEntries(['model','instructions','input','tools','tool_choice'].filter(key=>body[key]!==undefined).map(key=>[key,body[key]]));
}

function codec(model:string){
  model=model.trim();
  const legacy=/^(?:gpt-3\.5|text-embedding-)/i.test(model)||/^gpt-4/i.test(model)&&!/^gpt-4(?:o|\.1)/i.test(model);
  const tokenizer=legacy?cl100k:o200k;
  tokenizer.setMergeCacheSize(1024);
  return tokenizer;
}

// Match the upstream Responses estimator, including framing and tool overhead.
// Image data is represented by its MIME prefix; this is a preflight estimate.
export async function estimateInputTokens(body:Record<string,unknown>):Promise<number>{
  const encoder=await codec(String(body.model));
  const count=(value:unknown,trim=true)=>typeof value==='string'?(value=trim?value.trim():value,encoder.countTokens(value as string,{allowedSpecial:new Set(),disallowedSpecial:new Set()})):0;
  const compact=(value:unknown)=>JSON.stringify(value);
  let total=count(body.instructions);
  if(typeof body.input==='string')total+=count(body.input,false);
  else if(Array.isArray(body.input))for(const item of body.input){
    if(!item||typeof item!=='object'||Array.isArray(item)){total+=count(compact(item));continue;}
    total+=3+count(item.role)+(item.type==='message'?0:count(item.type));
    for(const key of ['name','arguments','output','call_id','id'])total+=count(item[key]);
    if(typeof item.content==='string')total+=count(item.content);
    else if(Array.isArray(item.content))for(const part of item.content){
      total+=1;
      if(['input_text','output_text','text'].includes(part?.type))total+=count(part.text);
      else if(part?.type==='input_image'){
        let url=typeof part.image_url==='string'?part.image_url.trim():'';
        if(/^data:/i.test(url)&&url.includes(','))url=url.slice(0,url.indexOf(','));
        total+=count(url);
      }else total+=count(part?.type);
    }
    else if(item.content!==undefined)total+=count(compact(item.content));
  }
  else if(body.input!==undefined)total+=count(compact(body.input));
  for(const tool of body.tools as unknown[]??[])total+=count(compact(tool));
  if(body.tool_choice!==undefined)total+=count(compact(body.tool_choice));
  return Math.max(1,total);
}

async function responseText(response:Response):Promise<string>{
  if(!response.body)return '';
  const reader=response.body.getReader(),decoder=new TextDecoder();let text='',bytes=0;
  try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;if(bytes>65536)throw new HttpError(502,'invalid_upstream_response');text+=decoder.decode(chunk.value,{stream:true});}return text+decoder.decode();}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

export async function countInputTokens(db:Database,account:Account&{platform?:Platform;type?:'oauth'|'apikey'},body:Record<string,unknown>,signal:AbortSignal,onDispatch:()=>void=()=>{},onResponse:()=>void=()=>{}):Promise<number>{
  const platform=account.platform??'openai';
  if(platform==='grok')return estimateInputTokens(body);
  if(platform!=='openai')throw new HttpError(501,'provider_protocol_unsupported');
  const apiKey=account.type==='apikey';
  let token:string;
  if(apiKey){
    const credentials=await decryptApiKeyCredentials(account,db.config.encryptionKey);
    if(credentials.base_url&&new URL(credentials.base_url).hostname!=='api.openai.com')return estimateInputTokens(body);
    token=credentials.api_key;
  }else token=(await credentialsFor(db,account)).access_token;
  onDispatch();
  let upstream:Response;
  try{upstream=await accountFetch(db,account,'https://api.openai.com/v1/responses/input_tokens',{
    method:'POST',redirect:'error',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json'},body:JSON.stringify(body),signal,
  });}catch(error){console.error("input_token_preflight_transport_failed",error instanceof Error?error.name:"unknown");throw error;}
  onResponse();
  const text=await responseText(upstream);
  if(!upstream.ok){
    const unsupported=upstream.status===404||!apiKey&&[401,403].includes(upstream.status)&&(/missing_scope|api\.responses\.write|missing scopes|insufficient_scope/i.test(text)||/input_tokens/i.test(text)&&/not found|not supported|unsupported/i.test(text)||upstream.status===403&&/^\s*(?:<!doctype html|<html)/i.test(text));
    if(unsupported)return estimateInputTokens(body);
    throw new HttpError(upstream.status>=400&&upstream.status<500?upstream.status:502,'upstream_request_failed');
  }
  let value;try{value=JSON.parse(text);}catch{throw new HttpError(502,'invalid_upstream_response');}
  if(!Number.isSafeInteger(value?.input_tokens)||value.input_tokens<0)throw new HttpError(502,'invalid_upstream_response');
  return value.input_tokens;
}
