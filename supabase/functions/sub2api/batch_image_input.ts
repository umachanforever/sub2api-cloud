import {HttpError} from './db.ts';
import type {GeminiBatchInput} from './gemini_batch.ts';
type Item=Record<string,unknown>;
export type BatchImageLimits={items:number;outputs:number;perItem:number;promptBytes:number;references:number;referenceBytes:number};
export const DEFAULT_BATCH_IMAGE_LIMITS:BatchImageLimits={items:200,outputs:200,perItem:4,promptBytes:8000,references:1000,referenceBytes:128*1024*1024};
export type BatchImageInput=GeminiBatchInput&{task_name:string;parent_batch_id:string;provider:''|'gemini_api'|'vertex';response_mime_type:string;aspect_ratio:string;image_size:'1K';metadata:Record<string,string>};
const size=(value:string)=>new TextEncoder().encode(value).length;
function value(input:unknown):string{if(input===undefined||input===null)return '';if(typeof input!=='string')throw new HttpError(400,'invalid_batch_input');return input.trim();}
function truncate(input:string,bytes:number):string{
 let result='',length=0;for(const character of input){const count=size(character);if(length+count>bytes)break;result+=character;length+=count;}return result;
}
function object(input:unknown):Item{if(!input||typeof input!=='object'||Array.isArray(input))throw new HttpError(400,'invalid_batch_input');return input as Item;}
export function batchImageInput(input:unknown,limits=DEFAULT_BATCH_IMAGE_LIMITS,now=new Date()):BatchImageInput{
 for(const key of ['items','outputs','perItem','promptBytes','references','referenceBytes'] as const){const limit=limits[key];if(!Number.isSafeInteger(limit)||limit<1)throw new HttpError(500,'invalid_batch_limits');}
 const body=object(input),model=value(body.model),provider=value(body.provider);
 if(!/^[A-Za-z0-9._-]{1,128}$/.test(model)||['.','..'].includes(model))throw new HttpError(400,'invalid_batch_model');
 if(!['','gemini_api','vertex'].includes(provider))throw new HttpError(400,'invalid_batch_provider');
 const imageSize=value(body.image_size)||'1K';if(imageSize.toUpperCase()!=='1K')throw new HttpError(400,'invalid_batch_image_size');
 if(!Array.isArray(body.items)||!body.items.length||body.items.length>limits.items)throw new HttpError(400,'invalid_batch_items');
 const items:GeminiBatchInput['items']=[],seen=new Set<string>();let references=0,referenceBytes=0;
 for(let index=0;index<body.items.length;index++){
  const raw=object(body.items[index]),id=value(raw.custom_id)||'item_'+String(index+1).padStart(6,'0'),prompt=value(raw.prompt);
  const count=raw.output_count===undefined||raw.output_count===0?1:raw.output_count;
  if(!Number.isSafeInteger(count)||(count as number)<1||(count as number)>limits.perItem||items.length+(count as number)>limits.outputs)throw new HttpError(400,'batch_output_limit_exceeded');
  if(!prompt)throw new HttpError(400,'invalid_batch_items');if(size(prompt)>limits.promptBytes)throw new HttpError(400,'batch_prompt_too_long');
  const refs=raw.reference_images??[];if(!Array.isArray(refs))throw new HttpError(400,'invalid_batch_reference');
  const maxRefs=model.toLowerCase().includes('pro-image')?14:model.toLowerCase().includes('flash-image')?3:0;
  if(refs.length>maxRefs)throw new HttpError(400,'batch_reference_limit_exceeded');
  const normalized:NonNullable<GeminiBatchInput['items'][number]['reference_images']>=[];
  for(const item of refs){
   const ref=object(item),mime=value(ref.mime_type).toLowerCase().replace(/^image\/jpg$/,'image/jpeg'),data=value(ref.data).replace(/[\r\n]/g,''),uri=value(ref.file_uri);
   const id=truncate(value(ref.id),80),type=truncate(value(ref.type),40),labels={...(id?{id}:{}),...(type?{type}:{})};
   if(!['image/png','image/jpeg','image/webp'].includes(mime)||Boolean(data)===Boolean(uri))throw new HttpError(400,'invalid_batch_reference');
   if(data){
    if(data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))throw new HttpError(400,'invalid_batch_reference');
    const bytes=data.length/4*3-(data.endsWith('==')?2:data.endsWith('=')?1:0);
    if(bytes>10*1024*1024)throw new HttpError(400,'invalid_batch_reference');
    referenceBytes+=bytes*(count as number);normalized.push({...labels,mime_type:mime,data});
   }else{
    if(!/^gs:\/\/[^/\s]+\/[^\r\n]+$/.test(uri))throw new HttpError(400,'invalid_batch_reference');normalized.push({...labels,mime_type:mime,file_uri:uri});
   }
  }
  references+=normalized.length*(count as number);
  if(references>limits.references||referenceBytes>limits.referenceBytes)throw new HttpError(400,'batch_reference_limit_exceeded');
  for(let repeat=1;repeat<=(count as number);repeat++){
   const expanded=(count as number)>1?id+'_'+String(repeat).padStart(Math.max(2,String(count).length),'0'):id;
   if(size(expanded)>255||/[\x00-\x1f\x7f]/.test(expanded))throw new HttpError(400,'invalid_batch_custom_id');
   if(seen.has(expanded))throw new HttpError(400,'duplicate_batch_custom_id');seen.add(expanded);
   items.push({custom_id:expanded,prompt,...(normalized.length?{reference_images:normalized.map(ref=>({...ref}))}:{})});
  }
 }
 const metadata:Record<string,string>=Object.create(null);
 if(body.metadata!==undefined&&body.metadata!==null){
  const source=object(body.metadata);
  for(const original of Object.keys(source).sort()){
   if(typeof source[original]!=='string')throw new HttpError(400,'invalid_batch_metadata');
   const key=original.trim();if(!key||size(key)>64||key.includes('\0'))continue;
   metadata[key]=truncate((source[original] as string).trim(),256);if(Object.keys(metadata).length===20)break;
  }
 }
 const parent=value(body.parent_batch_id);if(parent&&!/^imgbatch_[A-Za-z0-9_-]{1,55}$/.test(parent))throw new HttpError(400,'invalid_parent_batch');
 return {model,task_name:truncate(value(body.task_name)||new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(now),255),parent_batch_id:parent,provider:provider as BatchImageInput['provider'],response_mime_type:value(body.response_mime_type)||'image/png',aspect_ratio:value(body.aspect_ratio),image_size:'1K',metadata,items};
}
