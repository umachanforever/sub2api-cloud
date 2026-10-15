import {HttpError} from './db.ts';
import {buildHeaders,CODEX_RESPONSES_URL,type OAuthCredentials} from './gateway.ts';
import type {CodexIdentity} from './codex_identity.ts';
import type {apiKeyRequest} from './api_key_provider.ts';

export const directModels=new Set(['gpt-image-1.5','gpt-image-2','gpt-image-2.5-flare','gpt-image-2.5-sunburst','gpt-image-2.5-flare-2026-09-08','gpt-image-2.5-sunburst-2026-09-08']);
async function dataURL(file:Blob):Promise<string>{
  const bytes=new Uint8Array(await file.arrayBuffer());let binary='';
  for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
  return `data:${file.type||'application/octet-stream'};base64,${btoa(binary)}`;
}
// Keep Codex Images fields and endpoint selection aligned with upstream direct images.
export async function oauthImageRequest(credentials:OAuthCredentials,identity:CodexIdentity,path:string,body:Record<string,unknown>,form:FormData|undefined,signal:AbortSignal):Promise<ReturnType<typeof apiKeyRequest>>{
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
  const headers=buildHeaders(credentials,identity);
  if(!directModels.has(String(body.model))){
    const tool:Record<string,unknown>={...payload,type:'image_generation',action:path.endsWith('/edits')?'edit':'generate'};
    for(const field of ['prompt','images','mask','stream','input_fidelity'])delete tool[field];
    if(payload.mask)tool.input_image_mask=payload.mask;
    if(body.model==='dall-e-3'||tool.n===1)delete tool.n;
    const content:Record<string,unknown>[]=[{type:'input_text',text:body.prompt}];
    for(const image of (payload.images??[]) as {image_url:string}[])content.push({type:'input_image',image_url:image.image_url});
    headers.set('accept','text/event-stream');headers.set('openai-beta','responses=experimental');
    const request={model:'gpt-5.6-luna',stream:true,store:false,instructions:"When invoking the image_generation tool, use the user's image prompt verbatim. Do not rewrite, expand, summarize, embellish, translate, normalize punctuation, or add or remove visual details or constraints. Preserve the original language, wording, capitalization, quotes, and punctuation exactly.",reasoning:{effort:'medium',summary:'auto'},parallel_tool_calls:true,include:['reasoning.encrypted_content'],input:[{type:'message',role:'user',content}],tools:[tool],tool_choice:{type:'image_generation'}};
    return {url:CODEX_RESPONSES_URL,init:{method:'POST',headers,signal,redirect:'error',body:JSON.stringify(request)},streaming:body.stream===true};
  }
  headers.set('accept',body.stream===true?'text/event-stream':'application/json');
  return {url:'https://chatgpt.com/backend-api/codex/images/'+(path.endsWith('/edits')?'edits':'generations'),init:{method:'POST',headers,signal,redirect:'error',body:JSON.stringify(payload)},streaming:body.stream===true};
}

// Native edit events use a generation prefix; preserve the upstream client contract.
export function oauthImageOutput(value:Record<string,any>,body:Record<string,unknown>,edit:boolean,streaming:boolean):Record<string,any>{
  const mime=(format:unknown)=>format==='jpeg'||format==='jpg'?'image/jpeg':format==='webp'?'image/webp':'image/png';
  const convert=(item:Record<string,any>)=>{
    if(typeof body.model==='string')item.model=body.model;
    if(body.response_format==='url'&&typeof item.b64_json==='string'&&item.b64_json){
      item.url=`data:${mime(item.output_format??value.output_format??body.output_format)};base64,${item.b64_json}`;
      if(!streaming)delete item.b64_json;
    }
  };
  if(streaming){
    if(edit&&typeof value.type==='string'&&value.type.startsWith('image_generation.'))value.type=value.type.replace('image_generation.','image_edit.');
    convert(value);
  }else for(const item of value.data??[])convert(item);
  return value;
}
