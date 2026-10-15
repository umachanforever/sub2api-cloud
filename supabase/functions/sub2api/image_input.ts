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
  if(!Array.isArray(body.images)||!body.images.some(image=>image&&typeof image.image_url==='string'&&image.image_url.trim())||body.images.some(image=>image&&'file_id' in image))throw new HttpError(400,'image_input_required');
  if(body.mask&&typeof body.mask==='object'&&'file_id' in body.mask)throw new HttpError(400,'invalid_image_mask');
}
