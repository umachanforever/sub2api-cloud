import {HttpError} from './db.ts';
import {validateImageEdit} from './image_input.ts';

const ratios=['1:1','16:9','9:16','4:3','3:4','3:2','2:3','2:1','1:2','19.5:9','9:19.5','20:9','9:20'];

// Match the original gateway's Imagine geometry and edit upload conversion.
export function grokImageBody(body:Record<string,unknown>,edit:boolean):Record<string,unknown>{
  const out=structuredClone(body);
  if(out.model==='grok-imagine')out.model='grok-imagine-image-quality';
  const size=typeof out.size==='string'?out.size.trim().toLowerCase():'';
  const dimensions=/^(\d+)x(\d+)$/.exec(size);
  const width=dimensions?Number(dimensions[1]):0,height=dimensions?Number(dimensions[2]):0;
  const resolution=typeof out.resolution==='string'?out.resolution.trim().toLowerCase():'';
  if(['1k','2k'].includes(resolution))out.resolution=resolution;
  else if(['1k','2k','4k'].includes(size))out.resolution=size==='1k'?'1k':'2k';
  else if(width>0&&height>0)out.resolution=Math.max(width,height)<=1024?'1k':'2k';
  if(!(typeof out.aspect_ratio==='string'&&out.aspect_ratio.trim())&&width>0&&height>0){
    const ratio=width/height;
    out.aspect_ratio=ratios.reduce((best,next)=>{
      const number=(value:string)=>{const [a,b]=value.split(':').map(Number);return a/b;};
      return Math.abs(number(next)-ratio)<Math.abs(number(best)-ratio)?next:best;
    });
  }
  delete out.size;
  if(edit){
    validateImageEdit(out);
    const images=out.images as {image_url:string}[];
    if(images.length>3)throw new HttpError(400,'invalid_image_count');
    const native=images.map(image=>({url:image.image_url,type:'image_url'}));
    out.image=native[0];
    if(native.length>1)out.images=native;else delete out.images;
    if(out.mask)out.mask={url:(out.mask as {image_url:string}).image_url,type:'image_url'};
  }
  return out;
}

export async function grokImageForm(form:FormData,body:Record<string,unknown>):Promise<Record<string,unknown>>{
  const out={...body};
  const uploads=[...form].filter(([key,value])=>/^(?:image|image\[\]|image\[\d+\])$/.test(key)&&typeof value!=='string'&&value.size>0);
  if(!uploads.length||uploads.length>3)throw new HttpError(400,'invalid_image_count');
  const reference=async(value:FormDataEntryValue)=>{
    if(typeof value==='string'||!value.size||!/^image\/[a-zA-Z0-9.+-]+$/.test(value.type))throw new HttpError(400,'invalid_image_upload');
    const bytes=new Uint8Array(await value.arrayBuffer());
    let binary='';
    for(let offset=0;offset<bytes.length;offset+=32768)binary+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
    return {image_url:`data:${value.type};base64,${btoa(binary)}`};
  };
  out.images=await Promise.all(uploads.map(([,value])=>reference(value)));
  if(form.getAll('mask').length>1)throw new HttpError(400,'invalid_image_mask');
  const mask=form.get('mask');if(mask!==null)out.mask=await reference(mask);
  if(typeof out.n==='string'){
    if(!/^[1-9]\d*$/.test(out.n))throw new HttpError(400,'invalid_image_count');
    out.n=Number(out.n);
  }
  return out;
}
