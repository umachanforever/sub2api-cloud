import {HttpError} from './db.ts';

// Bound the wire body before multipart parsing, including uploads and boundaries.
export async function imageForm(request:Request,maxBytes:number):Promise<{form:FormData;body:Record<string,unknown>}>{
  const length=request.headers.get('content-length');
  if(length&&/^\d+$/.test(length)&&Number(length)>maxBytes){await request.body?.cancel();throw new HttpError(413,'request_too_large');}
  if(!request.body)throw new HttpError(400,'invalid_request');
  let bytes=0;
  const limited=request.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){bytes+=chunk.length;if(bytes>maxBytes)throw new HttpError(413,'request_too_large');controller.enqueue(chunk);}}));
  let form:FormData;
  try{form=await new Response(limited,{headers:{'content-type':request.headers.get('content-type')??''}}).formData();}
  catch(error){if(error instanceof HttpError)throw error;throw new HttpError(400,'invalid_request');}
  const body:Record<string,unknown>={};
  for(const [key,value] of form){if(typeof value==='string')body[key]=value;}
  for(const key of ['model','prompt','stream'])if(form.getAll(key).length>1)throw new HttpError(400,'invalid_request');
  if(body.stream!==undefined){if(!['true','false'].includes(body.stream as string))throw new HttpError(400,'invalid_stream');body.stream=body.stream==='true';}
  const images=[...form].filter(([key,value])=>/^(?:image|image\[\]|image\[\d+\])$/.test(key)&&typeof value!=='string'&&value.size>0);
  if(!images.length)throw new HttpError(400,'image_input_required');
  return {form,body};
}
export function validateImageEdit(body:Record<string,unknown>):void{
  const reference=(value:unknown):{image_url:string}=>{
    if(typeof value==='string'&&/^(?:https?:\/\/|data:image\/)/i.test(value.trim()))return {image_url:value.trim()};
    if(!value||typeof value!=='object'||Array.isArray(value)||'file_id' in value)throw new HttpError(400,'image_input_required');
    const image=value as Record<string,unknown>;
    const nested=image.image_url;
    const url=typeof image.url==='string'?image.url:typeof nested==='string'?nested:nested&&typeof nested==='object'&&!Array.isArray(nested)?(nested as Record<string,unknown>).url:undefined;
    if(typeof url!=='string'||!url.trim())throw new HttpError(400,'image_input_required');
    return {image_url:url.trim()};
  };
  const images:unknown[]=[];
  for(const key of ['image','images','reference_images']){
    if(body[key]!==undefined){
      if(Array.isArray(body[key])){for(const image of body[key])images.push(image);}else images.push(body[key]);
    }
  }
  if(!images.length)throw new HttpError(400,'image_input_required');
  body.images=images.map(reference);
  delete body.image;delete body.reference_images;
  if(body.mask!==undefined){
    try{body.mask=reference(body.mask);}catch{throw new HttpError(400,'invalid_image_mask');}
  }
}
