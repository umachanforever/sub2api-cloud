export function responsesWebSocketMode(account:{platform?:string;type?:string;websocket_settings?:Record<string,unknown>}):string{
 if(account.platform==='grok')return 'http_bridge';
 if(account.platform!=='openai')return 'off';
 const extra=account.websocket_settings??{},prefix=account.type==='apikey'?'openai_apikey':'openai_oauth';
 const raw=extra[prefix+'_responses_websockets_v2_mode'];
 if(typeof raw==='string'){
  const mode=raw.trim().toLowerCase();if(['off','ctx_pool','shared','dedicated','passthrough','http_bridge'].includes(mode))return mode;
 }
 for(const key of [prefix+'_responses_websockets_v2_enabled','responses_websockets_v2_enabled','openai_ws_enabled'])if(typeof extra[key]==='boolean')return extra[key]?'ctx_pool':'off';
 return 'ctx_pool';
}
