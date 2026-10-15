import {HttpError} from './db.ts';
import {VertexServiceAccountToken} from './vertex_auth.ts';
import {vertexCatalogLocation} from './vertex_catalog.ts';

// Match the original Express (API key only) and project-scoped Vertex endpoints.
export async function vertexGeminiRequest(credentials:Record<string,unknown>,path:string,body:Record<string,unknown>,signal:AbortSignal,fetcher:typeof fetch):Promise<{url:string;init:RequestInit;streaming:boolean}> {
  const match=/^\/v1beta\/models\/([^/]+):(generateContent|streamGenerateContent|countTokens)$/.exec(path);
  if(!match)throw new HttpError(400,'invalid_vertex_endpoint');
  let model:string;try{model=decodeURIComponent(match[1]);}catch{throw new HttpError(400,'invalid_vertex_model');}
  if(!/^[a-zA-Z0-9._:-]{1,200}$/.test(model)||model==='.'||model==='..')throw new HttpError(400,'invalid_vertex_model');
  const streaming=match[2]==='streamGenerateContent',apiKey=typeof credentials.auth_mode==='string'&&credentials.auth_mode.trim()==='apikey';
  const headers=new Headers({'content-type':'application/json',accept:streaming?'text/event-stream':'application/json'});
  let project=typeof credentials.project_id==='string'?credentials.project_id.trim():'';
  let tokens:VertexServiceAccountToken|undefined;
  if(apiKey){
    const key=typeof credentials.api_key==='string'?credentials.api_key.trim():'';
    if(!key||/[\s\u0000-\u001f\u007f]/.test(key))throw new HttpError(400,'invalid_vertex_api_key');
    headers.set('x-goog-api-key',key);
  } else {
    tokens=new VertexServiceAccountToken(credentials,fetcher);
    project=project||tokens.project;
  }
  let prefix='https://aiplatform.googleapis.com/v1';
  if(project){
    if(!/^[a-zA-Z0-9_-]{1,128}$/.test(project))throw new HttpError(400,'invalid_vertex_project');
    const location=vertexCatalogLocation(credentials,model),host=location==='global'?'aiplatform.googleapis.com':location+'-aiplatform.googleapis.com';
    prefix=`https://${host}/v1/projects/${project}/locations/${location}`;
  } else if(!apiKey)throw new HttpError(400,'invalid_vertex_project');
  const url=`${prefix}/publishers/google/models/${encodeURIComponent(model)}:${match[2]}${streaming?'?alt=sse':''}`;
  if(tokens)headers.set('authorization','Bearer '+await tokens.accessToken());
  return {url,init:{method:'POST',redirect:'error',signal,headers,body:JSON.stringify(body)},streaming};
}
