import {HttpError} from './db.ts';
import {VertexServiceAccountToken} from './vertex_auth.ts';
import {vertexCatalogLocation} from './vertex_catalog.ts';

// Pinned to the original claude.ModelIDOverrides and Vertex beta allowlist.
export const VERTEX_CLAUDE_ALIASES:Record<string,string>={
  'claude-sonnet-4-5':'claude-sonnet-4-5-20250929',
  'claude-opus-4-5':'claude-opus-4-5-20251101',
  'claude-haiku-4-5':'claude-haiku-4-5-20251001',
};
export const VERTEX_ANTHROPIC_BETAS=[
  'context-1m-2025-08-07','context-management-2025-06-27',
  'fine-grained-tool-streaming-2025-05-14','interleaved-thinking-2025-05-14',
];
export function vertexAnthropicModel(model:string,explicit=false):string {
  model=model.trim();if(explicit)return model;
  return (Object.hasOwn(VERTEX_CLAUDE_ALIASES,model)?VERTEX_CLAUDE_ALIASES[model]:model).replace(/-(\d{8})$/,'@$1');
}
export function vertexAnthropicBody(body:Record<string,unknown>,beta:string,model:string):{body:Record<string,unknown>;beta:string} {
  const payload=structuredClone(body);delete payload.model;payload.anthropic_version='vertex-2023-10-16';
  const tokens=new Set(beta.split(',').map(value=>value.trim()).filter(value=>VERTEX_ANTHROPIC_BETAS.includes(value)));
  const tools=Array.isArray(payload.tools)?payload.tools:[];
  if(/^claude-(?:sonnet|haiku)-5-5(?:$|-)/.test(model.split('@')[0])&&tools.some(tool=>tool&&typeof tool==='object'&&['computer_toolset_20260801','browser_toolset_20260801'].includes(String((tool as Record<string,unknown>).type))))tokens.delete('fine-grained-tool-streaming-2025-05-14');
  if(!tokens.has('context-management-2025-06-27'))delete payload.context_management;
  if(payload.thinking&&typeof payload.thinking==='object'&&!Array.isArray(payload.thinking))delete (payload.thinking as Record<string,unknown>).block_binding;
  delete payload.fallbacks;delete payload.fallback_credit_token;
  if(Array.isArray(payload.messages))for(const message of payload.messages)if(message&&typeof message==='object'&&!Array.isArray(message))delete (message as Record<string,unknown>).output_config;
  return {body:payload,beta:[...tokens].join(',')};
}
export async function vertexAnthropicRequest(credentials:Record<string,unknown>,body:Record<string,unknown>,request:Request,signal:AbortSignal,fetcher:typeof fetch,explicit=false):Promise<{url:string;init:RequestInit;streaming:boolean;upstreamModel:string}> {
  if(typeof body.model!=='string')throw new HttpError(400,'invalid_vertex_model');
  const model=vertexAnthropicModel(body.model,explicit);
  if(!/^[a-zA-Z0-9._:-]+(?:@[0-9]{8})?$/.test(model)||model.length>200||model==='.'||model==='..')throw new HttpError(400,'invalid_vertex_model');
  const tokens=new VertexServiceAccountToken(credentials,fetcher),project=typeof credentials.project_id==='string'&&credentials.project_id.trim()?credentials.project_id.trim():tokens.project;
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(project))throw new HttpError(400,'invalid_vertex_project');
  const location=vertexCatalogLocation(credentials,model),host=location==='global'?'aiplatform.googleapis.com':location+'-aiplatform.googleapis.com',streaming=body.stream===true;
  const transformed=vertexAnthropicBody(body,request.headers.get('anthropic-beta')??'',model);
  const headers=new Headers({'content-type':'application/json',accept:streaming?'text/event-stream':'application/json',authorization:'Bearer '+await tokens.accessToken()});
  if(transformed.beta)headers.set('anthropic-beta',transformed.beta);
  const url=`https://${host}/v1/projects/${project}/locations/${location}/publishers/anthropic/models/${encodeURIComponent(model).replace('%40','@')}:${streaming?'streamRawPredict':'rawPredict'}`;
  return {url,init:{method:'POST',redirect:'error',signal,headers,body:JSON.stringify(transformed.body)},streaming,upstreamModel:model};
}
