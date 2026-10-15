import {HttpError} from './db.ts';
import {buildHeaders,type OAuthCredentials} from './gateway.ts';
import type {CodexIdentity} from './codex_identity.ts';
import type {apiKeyRequest} from './api_key_provider.ts';

const directModels=new Set(['gpt-image-1.5','gpt-image-2','gpt-image-2.5-flare','gpt-image-2.5-sunburst','gpt-image-2.5-flare-2026-09-08','gpt-image-2.5-sunburst-2026-09-08']);
async function dataURL(file:Blob):Promise<string>{
  const bytes=new Uint8Array(await file.arrayBuffer());let binary='';
  for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
  return `data:${file.type||'application/octet-stream'};base64,${btoa(binary)}`;
}
// Keep Codex Images fields and endpoint selection aligned with upstream direct images.
export async function oauthImageRequest(credentials:OAuthCredentials,identity:CodexIdentity,path:string,body:Record<string,unknown>,form:FormData|undefined,signal:AbortSignal):Promise<ReturnType<typeof apiKeyRequest>>{
  if(!directModels.has(String(body.model)))throw new HttpError(501,'image_model_requires_responses_bridge');
  const payload:Record<string,unknown>={model:body.model,prompt:body.prompt};
  for(const field of ['size','quality','background','output_format','moderation','input_fidelity','style'])if(typeof body[field]==='string'&&(body[field] as string).trim())payload[field]=(body[field] as string).trim();
  for(const field of ['n','output_compression','partial_images'])if(body[field]!==undefined){const value=form?Number(body[field]):body[field];if(!Number.isSafeInteger(value)||(value as number)<(field==='n'?1:0))throw new HttpError(400,'invalid_image_options');payload[field]=value;}
  if(body.stream===true)payload.stream=true;
  if(path.endsWith('/edits')){
    const images=form?[]:body.images as {image_url:string}[];
    if(form)for(const [key,value] of form){if(/^(?:image|image\[\]|image\[\d+\])$/.test(key)&&typeof value!=='string')images.push({image_url:await dataURL(value)});}
    if(!images?.length)throw new HttpError(400,'image_input_required');payload.images=images;
    const mask=form?.get('mask');
    if(mask&&typeof mask!=='string')payload.mask={image_url:await dataURL(mask)};
    else if(body.mask&&typeof body.mask==='object'&&'image_url' in body.mask)payload.mask={image_url:body.mask.image_url};
  }
  const headers=buildHeaders(credentials,identity);headers.set('accept',body.stream===true?'text/event-stream':'application/json');
  return {url:'https://chatgpt.com/backend-api/codex/images/'+(path.endsWith('/edits')?'edits':'generations'),init:{method:'POST',headers,signal,redirect:'error',body:JSON.stringify(payload)},streaming:body.stream===true};
}
