import {HttpError} from './db.ts';
import {VertexServiceAccountToken} from './vertex_auth.ts';
import {GEMINI_FALLBACK_IDS,geminiFallbackModel} from './gemini_catalog.ts';

export function vertexCatalogLocation(credentials:Record<string,unknown>,model?:string):string {
  const overrides=credentials.vertex_model_locations;
  const override=model&&overrides&&typeof overrides==='object'&&!Array.isArray(overrides)?(overrides as Record<string,unknown>)[model]:undefined;
  const location=[override,credentials.location,credentials.vertex_location].find(value=>typeof value==='string'&&value.trim());
  const result=typeof location==='string'?location.trim():'us-central1';
  if(!/^[a-z0-9-]+$/.test(result))throw new HttpError(400,'invalid_vertex_location');
  return result;
}

async function catalogPage(response:Response):Promise<Record<string,unknown>> {
  if(!response.body)throw new HttpError(502,'invalid_vertex_catalog');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>8*1024*1024)throw new HttpError(502,'vertex_catalog_too_large');chunks.push(value);}
  } catch(error){await reader.cancel().catch(()=>{});throw error;} finally{reader.releaseLock();}
  const body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.length;}
  let value;try{value=JSON.parse(new TextDecoder().decode(body));}catch{throw new HttpError(502,'invalid_vertex_catalog');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(502,'invalid_vertex_catalog');
  return value;
}

// Original Vertex listings collect at most 20 Google publisher pages of 300 models.
export async function vertexGeminiCatalog(credentials:Record<string,unknown>,path:string,fetcher:typeof fetch,signal:AbortSignal):Promise<Response> {
  const segment=/\/models\/([^/]+)$/.exec(path)?.[1],model=segment?decodeURIComponent(segment):undefined;
  if(typeof credentials.auth_mode==='string'&&credentials.auth_mode.trim()==='apikey')return Response.json(model?geminiFallbackModel(model):{models:GEMINI_FALLBACK_IDS.map(geminiFallbackModel)});
  const location=vertexCatalogLocation(credentials,model);
  const tokens=new VertexServiceAccountToken(credentials,fetcher),token=await tokens.accessToken();
  const host=location==='global'?'aiplatform.googleapis.com':location+'-aiplatform.googleapis.com';
  const models=new Set<string>();let pageToken='';
  for(let page=0;page<20;page++){
    const url=new URL(`https://${host}/v1beta1/publishers/google/models`);url.searchParams.set('pageSize','300');if(pageToken)url.searchParams.set('pageToken',pageToken);
    const response=await fetcher(url.href,{method:'GET',redirect:'error',signal,headers:{authorization:'Bearer '+token,accept:'application/json'}});
    if(!response.ok)return response;
    const value=await catalogPage(response);
    if(value.publisherModels!==undefined&&(!Array.isArray(value.publisherModels)||value.publisherModels.some(entry=>!entry||typeof entry!=='object'||Array.isArray(entry)||typeof entry.name!=='string')))throw new HttpError(502,'invalid_vertex_catalog');
    for(const entry of (value.publisherModels??[]) as {name:string}[]){const name=entry.name.trim();if(name.startsWith('publishers/google/models/gemini-')&&name.length>'publishers/google/models/gemini-'.length)models.add(name.slice('publishers/google/models/'.length));}
    if(value.nextPageToken!==undefined&&typeof value.nextPageToken!=='string')throw new HttpError(502,'invalid_vertex_catalog');
    pageToken=(value.nextPageToken as string|undefined)?.trim()??'';
    if(!pageToken){
      if(!models.size)throw new HttpError(502,'vertex_catalog_empty');
      if(model)return models.has(model)?Response.json(geminiFallbackModel(model)):Response.json({error:{code:404,status:'NOT_FOUND',message:'Model not found'}},{status:404});
      return Response.json({models:[...models].sort().map(geminiFallbackModel)});
    }
  }
  throw new HttpError(502,'vertex_catalog_pagination_limit');
}
