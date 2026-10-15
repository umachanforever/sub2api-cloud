import {type Account,credentialsFor} from './accounts.ts';
import {accountFetch} from './account_proxy.ts';
import {currentCodexIdentity} from './codex_identity.ts';
import {decryptApiKeyCredentials} from './credential_store.ts';
import {Database,HttpError} from './db.ts';
import {buildHeaders,CODEX_RESPONSES_URL,type Platform} from './gateway.ts';
import {responseEvents} from './openai_protocol.ts';

type Item=Record<string,any>;
export class SearchUpstreamError extends HttpError {
  readonly upstreamStatus:number;
  constructor(upstreamStatus:number){super(upstreamStatus>=400&&upstreamStatus<500?upstreamStatus:502,"upstream_request_failed");this.upstreamStatus=upstreamStatus;}
}
export function searchRequest(body:Item):Item{
  const value={...body};
  for(const field of ['prompt_cache_key','prompt_cache_retention','store'])delete value[field];
  return value;
}
export function searchResponsesBody(body:Item):Item{
  let prompt='Execute this Codex standalone web.run request for another model.\nUse the hosted web_search tool when web/current information is needed.\nReturn concise source-backed results. Include titles, URLs, dates, and direct answers when available.\n';
  for(const [field,title,limit] of [['commands','Commands JSON',12000],['settings','Search settings JSON',4000],['input','Recent conversation/input JSON',8000]] as const){
    if(body[field]===undefined)continue;
    const text=JSON.stringify(body[field]);prompt+=`\n${title}:\n${text.slice(0,limit)}${text.length>limit?'\n...<truncated>':''}\n`;
  }
  const tool:Item={type:'web_search'};
  if(typeof body.settings?.search_context_size==='string'&&body.settings.search_context_size.trim())tool.search_context_size=body.settings.search_context_size.trim();
  if(body.settings?.user_location&&typeof body.settings.user_location==='object'&&!Array.isArray(body.settings.user_location))tool.user_location=body.settings.user_location;
  return {model:body.model,stream:true,store:false,input:[{role:'user',content:[{type:'input_text',text:prompt}]}],tools:[tool]};
}
async function bounded(response:Response):Promise<ReadableStream<Uint8Array>>{
  if(!response.body)throw new HttpError(502,'invalid_upstream_response');
  let bytes=0;
  return response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){bytes+=chunk.length;if(bytes>32*1024*1024)throw new HttpError(502,'invalid_upstream_response');controller.enqueue(chunk);}}));
}
export async function searchFromResponses(response:Response):Promise<Item>{
  const reader=(await bounded(response)).getReader();let output='',completed:Item|undefined;
  const results:Item[]=[],seen=new Set<string>();
  const citations=(value:unknown):void=>{
    if(!value||typeof value!=='object')return;
    const item=value as Item;
    if(item.type==='url_citation'&&typeof item.url==='string'&&item.url.trim()&&!seen.has(item.url.trim())){
      const url=item.url.trim();seen.add(url);results.push({type:'text_result',ref_id:`turn0search${results.length}`,url,...(typeof item.title==='string'&&item.title.trim()?{title:item.title.trim()}:{})});
    }
    for(const child of Object.values(item))citations(child);
  };
  try{
    for await(const event of responseEvents(reader)){
      if(['error','response.failed','response.incomplete'].includes(event.type))throw new HttpError(502,'invalid_upstream_response');
      if(event.type==='response.output_text.delta'&&typeof event.delta==='string')output+=event.delta;
      if(event.type==='response.completed'){
        if(!event.response||typeof event.response!=='object'||Array.isArray(event.response)||event.response.status!==undefined&&event.response.status!=='completed')throw new HttpError(502,'invalid_upstream_response');
        completed=event.response;
      }
      citations(event);
    }
    if(!completed)throw new HttpError(502,'invalid_upstream_response');
    if(!output.trim())output=(completed.output??[]).filter((item:Item)=>item.type==='message').flatMap((item:Item)=>item.content??[]).filter((part:Item)=>part.type==='output_text'&&typeof part.text==='string').map((part:Item)=>part.text).join('');
    return {output,...(results.length?{results}:{})};
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function alphaSearch(db:Database,account:Account&{platform?:Platform;type?:'oauth'|'apikey'},body:Item,request:Request,signal:AbortSignal,onDispatch:()=>void,onResponse:()=>void):Promise<{value:Item;headers:Headers}>{
  if((account.platform??'openai')!=='openai')throw new HttpError(501,'provider_protocol_unsupported');
  body=searchRequest(body);
  let url:string,headers:Headers,payload=body,pat=false;
  if(account.type==='apikey'){
    const credentials=await decryptApiKeyCredentials(account,db.config.encryptionKey);
    url=(credentials.base_url||'https://api.openai.com')+'/v1/alpha/search';
    headers=new Headers({authorization:`Bearer ${credentials.api_key}`,'content-type':'application/json',accept:'application/json'});
  }else{
    const credentials=await credentialsFor(db,account),identity=await currentCodexIdentity(db,account,credentials);
    headers=buildHeaders(credentials,identity);pat=credentials.access_token.startsWith('at-');
    url=pat?CODEX_RESPONSES_URL:'https://chatgpt.com/backend-api/codex/alpha/search';
    if(pat)payload=searchResponsesBody(body);
    else{headers.delete('openai-beta');headers.set('accept','application/json');}
    const metadata=request.headers.get('x-codex-turn-metadata');
    if(metadata&&metadata.length<=8192)headers.set('x-codex-turn-metadata',metadata);
  }
  if(!pat)new URL(request.url).searchParams.forEach((value,key)=>{const target=new URL(url);target.searchParams.append(key,value);url=target.href;});
  onDispatch();
  const response=await accountFetch(db,account,url,{method:'POST',redirect:'error',headers,body:JSON.stringify(payload),signal});onResponse();
  if(!response.ok){await response.body?.cancel();throw new SearchUpstreamError(response.status);}
  let value:Item;
  if(pat)value=await searchFromResponses(response);
  else{
    try{value=await new Response(await bounded(response)).json();}catch{throw new HttpError(502,'invalid_upstream_response');}
    if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(502,'invalid_upstream_response');
  }
  return {value,headers:response.headers};
}
