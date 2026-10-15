import profiles from './provider_profiles.json' with {type:'json'};
import {HttpError} from './db.ts';

export type MultiProtocolPlatform = keyof typeof profiles;
export type ProviderProtocol = 'chat_completions'|'responses'|'anthropic';
export type ProtocolRule = {pattern:string;protocol:ProviderProtocol;protocols?:ProviderProtocol[]};
export type ProviderOptions = {account_mode?:string;api_protocol?:ProviderProtocol|'adaptive';api_base_urls?:Partial<Record<ProviderProtocol,string>>;protocol_rules?:ProtocolRule[]};
type Endpoints={BaseURLs:Partial<Record<ProviderProtocol,string>>;ProtocolRules:ProtocolRule[]|null};
type Profile={DefaultMode:string;Modes:Record<string,Endpoints>;Routing:string;ResponsesPath:string};
export function multiProtocolProvider(platform:unknown):platform is MultiProtocolPlatform {
  return typeof platform==='string'&&Object.hasOwn(profiles,platform);
}
function profile(platform:MultiProtocolPlatform):Profile{return profiles[platform] as Profile;}
function endpoints(platform:MultiProtocolPlatform,options:ProviderOptions):Endpoints{
  const p=profile(platform);return p.Modes[options.account_mode??'']??p.Modes[p.DefaultMode];
}
const protocols:ProviderProtocol[]=['chat_completions','responses','anthropic'];
function officialBase(platform:MultiProtocolPlatform,value:unknown):string{
  if(typeof value!=='string')throw new HttpError(400,'invalid_base_url');
  let url:URL;try{url=new URL(value);}catch{throw new HttpError(400,'invalid_base_url');}
  const normalized=url.origin+url.pathname.replace(/\/+$/,'');
  if(url.username||url.password||url.search||url.hash||!Object.values(profile(platform).Modes).some(mode=>Object.values(mode.BaseURLs).includes(normalized)))throw new HttpError(501,'custom_base_url_unsupported');
  return normalized;
}
export function parseProviderOptions(platform:MultiProtocolPlatform,input:Record<string,unknown>):ProviderOptions & {base_url?:string}{
  const out:ProviderOptions & {base_url?:string}={};
  if(input.account_mode!==undefined&&input.account_mode!==''){
    if(typeof input.account_mode!=='string'||!Object.hasOwn(profile(platform).Modes,input.account_mode))throw new HttpError(400,'invalid_account_mode');
    out.account_mode=input.account_mode;
  }
  if(input.api_protocol!==undefined&&input.api_protocol!==''){
    if(![...protocols,'adaptive'].includes(input.api_protocol as string))throw new HttpError(400,'invalid_api_protocol');
    out.api_protocol=input.api_protocol as ProviderOptions['api_protocol'];
  }
  if(input.base_url!==undefined&&input.base_url!=='')out.base_url=officialBase(platform,input.base_url);
  if(input.api_base_urls!==undefined){
    const bases=input.api_base_urls;
    if(!bases||typeof bases!=='object'||Array.isArray(bases))throw new HttpError(400,'invalid_api_base_urls');
    out.api_base_urls={};
    for(const [protocol,base] of Object.entries(bases)){
      if(!protocols.includes(protocol as ProviderProtocol))throw new HttpError(400,'invalid_api_base_urls');
      if(base!==null&&base!=='')out.api_base_urls[protocol as ProviderProtocol]=officialBase(platform,base);
    }
  }
  if(input.protocol_rules!==undefined){
    if(!Array.isArray(input.protocol_rules)||input.protocol_rules.length>64)throw new HttpError(400,'invalid_protocol_rules');
    out.protocol_rules=input.protocol_rules.map(rule=>{
      if(!rule||typeof rule!=='object'||Array.isArray(rule)||typeof rule.pattern!=='string')throw new HttpError(400,'invalid_protocol_rules');
      const pattern=rule.pattern.trim().toLowerCase();
      if(!pattern||pattern.length>128||/\s|[\x00-\x1f\x7f]/.test(pattern)||pattern.replace(/\*$/,'').includes('*'))throw new HttpError(400,'invalid_protocol_rules');
      if(rule.protocols!==undefined&&(!Array.isArray(rule.protocols)||rule.protocols.some((p:unknown)=>!protocols.includes(p as ProviderProtocol))))throw new HttpError(400,'invalid_protocol_rules');
      const protocol=rule.protocol||rule.protocols?.[0];
      if(!protocols.includes(protocol))throw new HttpError(400,'invalid_protocol_rules');
      return {pattern,protocol,...(rule.protocols?{protocols:[...new Set([protocol,...rule.protocols])] as ProviderProtocol[]}: {})};
    });
  }
  return out;
}
export function providerProtocol(platform:MultiProtocolPlatform,options:ProviderOptions,inbound:ProviderProtocol,model:string,catalog:ProviderProtocol[]=[]):ProviderProtocol{
  const p=profile(platform),mode=endpoints(platform,options);
  let configured=options.api_protocol;
  if(configured==='responses'&&!mode.BaseURLs.responses)configured='chat_completions';
  if(configured&&configured!=='adaptive')return configured;
  if(p.Routing==='by_model'){
    const normalized=model.trim().toLowerCase();
    const match=(rules:ProtocolRule[])=>rules.find(rule=>rule.pattern.endsWith('*')?normalized.startsWith(rule.pattern.slice(0,-1)):normalized===rule.pattern);
    const configuredRule=options.protocol_rules?match(options.protocol_rules):undefined;
    const builtin=match(mode.ProtocolRules??[]);
    const supported=[...new Set(catalog.filter(protocol=>mode.BaseURLs[protocol]))];
    const preferred=builtin?.protocol;
    const rule=configuredRule??(options.protocol_rules?undefined:builtin);
    const available=configuredRule?(configuredRule.protocols??[configuredRule.protocol]):supported.length?(preferred&&supported.includes(preferred)?[preferred,...supported.filter(p=>p!==preferred)]:supported):rule?.protocols??[rule?.protocol??'chat_completions'];
    return available.includes(inbound)?inbound:available[0];
  }
  return configured==='adaptive'&&mode.BaseURLs[inbound]?inbound:'chat_completions';
}
export function providerHasModelCatalog(platform:MultiProtocolPlatform,options:ProviderOptions):boolean{
  return !!(profiles[platform] as Profile & {ModelCatalog:boolean}).ModelCatalog&&(!options.api_protocol||options.api_protocol==='adaptive');
}
export function providerEndpoint(platform:MultiProtocolPlatform,options:ProviderOptions & {base_url?:string},protocol:ProviderProtocol|'models'):string{
  const mode=endpoints(platform,options),p=profile(platform);
  const adaptive=options.api_protocol==='adaptive'||!options.api_protocol&&p.Routing==='by_model';
  const baseProtocol=protocol==='models'?'chat_completions':protocol;
  const base=(adaptive?options.api_base_urls?.[baseProtocol]:undefined)??
    (adaptive&&baseProtocol!=='chat_completions'||protocol==='models'&&options.api_protocol==='anthropic'?undefined:options.base_url)??mode.BaseURLs[baseProtocol];
  if(!base)throw new HttpError(501,'provider_protocol_unsupported');
  const endpoint=protocol==='models'?'/v1/models':protocol==='anthropic'?'/v1/messages':protocol==='responses'?(p.ResponsesPath||'/v1/responses'):'/v1/chat/completions';
  const url=new URL(base),path=url.pathname.replace(/\/+$/,''),relative=endpoint.replace(/^\/v1/,'');
  url.pathname=path.endsWith(endpoint)||path.endsWith(relative)?path:path+(/\/v\d+(?:\.\d+|(?:alpha|beta|preview).*)?$/i.test(path)?relative:endpoint);
  return url.href;
}

export function openCodeSession(request:Request,body:Record<string,any>|undefined,generate:boolean):string|undefined{
  const sanitize=(value:unknown)=>typeof value==='string'&&value.trim()&&Array.from(value.trim()).length<=255&&!/[\x00-\x1f\x7f]/.test(value)?value.trim():undefined;
  for(const name of ['x-opencode-session','session-id','session_id','conversation_id','x-session-affinity','x-session-id','x-conversation-id','x-claude-code-session-id']){
    const value=sanitize(request.headers.get(name));if(value)return value;
  }
  const cache=sanitize(body?.prompt_cache_key);if(cache)return cache;
  let user=body?.metadata?.user_id;
  if(typeof user==='string'&&user.trim().startsWith('{')){
    try{const value=JSON.parse(user)?.session_id;if(typeof value==='string'&&value.trim())user=value;}catch{/* Keep plain metadata when it is not JSON. */}
  }
  return sanitize(user)??(generate?crypto.randomUUID():undefined);
}
