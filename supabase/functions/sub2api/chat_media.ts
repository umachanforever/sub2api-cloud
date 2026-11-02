import {Database,HttpError} from './db.ts';
import {putArtifact,signArtifact,imageArtifactPath,deleteArtifacts} from './artifact_storage.ts';
import {responseEvents} from './openai_protocol.ts';
import {chatImageMarkdown,IMAGE_CHAT_FRAME_LIMIT} from './chat_images.ts';
import {ChatImageText,nativeImageFileTool,nativeImageDownload,chatImageSource} from './chat_image_delivery.ts';
type Item=Record<string,any>;

export async function publishChatImage(db:Database,item:Item,leaseId:string,signal:AbortSignal,cache=new Map<string,string>()):Promise<void>{
  if(item?.type!=='image_generation_call')return;
  // Validate failure and format before storing any bytes or issuing a URL.
  const markdown=chatImageMarkdown(item);
  if(item.chat_image_url&&!item.result){if(chatImageSource(item.chat_image_url).origin!==new URL(db.config.url).origin)throw new HttpError(502,'invalid_generated_image');return;}
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(item.result));
  const hash=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  let url=cache.get(hash);
  if(!url){
   // Use verified byte signatures, not potentially inaccurate provider metadata.
   const mime=/data:(image\/(?:png|jpeg|webp|gif));base64,/.exec(markdown)?.[1];
   if(!mime||mime==='image/gif')throw new HttpError(502,'invalid_generated_image');
   const format=mime==='image/jpeg'?'jpg':mime==='image/webp'?'webp':'png';
   const path=imageArtifactPath('imgtask_'+crypto.randomUUID().replaceAll('-',''),1,format);
   if(!await db.rpc<boolean>('s2a_chat_media_register',{p_lease_id:leaseId,p_path:path}))throw new HttpError(403,'image_generation_forbidden');
   const binary=atob(item.result),bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));
   await putArtifact(db,path,bytes,mime,signal);
   url=await signArtifact(db,path,604800);cache.set(hash,url);
  }
  item.chat_image_url=url;
  delete item.result;
 }

// Normalize native GPT items and Gemini image text through the same private original-file delivery.
export function publishChatMedia(db:Database,upstream:Response,leaseId:string,signal:AbortSignal,client:Item={}):Response{
 if(!upstream.body)throw new HttpError(502,'invalid_upstream_response');
 const reader=upstream.body.getReader(),events=responseEvents(reader,IMAGE_CHAT_FRAME_LIMIT),cache=new Map<string,string>();
 const fileTool=nativeImageFileTool(client),sources=new Set<string>(),images=new Map<string,Item>(),parsers=new Map<string,ChatImageText>();
 let cancelled=false;const queued:Item[]=[];
 const encoder=new TextEncoder();
 async function render(item:Item,structured=false):Promise<string>{
  await publishChatImage(db,item,leaseId,signal,cache);
  sources.add(item.chat_image_url);if(structured)images.set(item.id??item.chat_image_url,item);
  if(sources.size>16)throw new HttpError(502,'generated_image_limit');
  return fileTool?'':chatImageMarkdown(item);
 }
 async function text(value:string,parser=new ChatImageText(),final=true):Promise<string>{
  let result='';
  for(const piece of parser.feed(value,final))result+='image' in piece?await render(piece.image):piece.text;
  return result;
 }
 async function transform(event:Item):Promise<Item|undefined>{
  if(event.item?.type==='image_generation_call'){
   if(event.type==='response.output_item.done')await render(event.item,true);
   return fileTool?undefined:event;
  }
  if(event.type==='response.output_text.delta'){
   const key=JSON.stringify([event.item_id,event.output_index,event.content_index]);
   let parser=parsers.get(key);if(!parser){parser=new ChatImageText();parsers.set(key,parser);}
   event.delta=await text(event.delta??'',parser,false);
   return event.delta?event:undefined;
  }
  if(event.type==='response.output_text.done'&&typeof event.text==='string')event.text=await text(event.text);
  if(event.part?.type==='output_text'&&typeof event.part.text==='string')event.part.text=await text(event.part.text);
  async function message(item:Item){
   if(item.type==='message')for(const part of item.content??[])if(part.type==='output_text'&&typeof part.text==='string')part.text=await text(part.text);
  }
  if(event.item)await message(event.item);
  if(['response.completed','response.incomplete'].includes(event.type)){
   // Flush split image delimiters before the terminal response; incomplete images fail explicitly.
   for(const parser of parsers.values()){const tail=await text('',parser,true);if(tail)queued.push({type:'response.output_text.delta',delta:tail});}
   const output:Item[]=event.response?.output??[];
   for(const item of output){if(item.type==='image_generation_call')await render(item,true);else await message(item);}
   if(fileTool&&sources.size){
    // Preserve caller tool ordering: one export command handles all originals.
    if(client.parallel_tool_calls===false&&output.some(item=>item.type==='function_call'))throw new HttpError(502,'image_delivery_tool_conflict');
    const tool=client.tools.find((tool:Item)=>(tool.function??tool).name===fileTool),parameters=(tool.function??tool).parameters;
    event.response.output=[...output.filter(item=>item.type!=='image_generation_call'),nativeImageDownload([...sources],fileTool,parameters)];
   }else{
    const ids=new Set(output.filter(item=>item.type==='image_generation_call').map(item=>item.id??item.chat_image_url));
    event.response.output=[...output,...[...images].filter(([key])=>!ids.has(key)).map(([,item])=>item)];
   }
  }
  return event;
 }
 const body=new ReadableStream<Uint8Array>({async pull(controller){
  try{
   while(!cancelled){
    if(queued.length){controller.enqueue(encoder.encode('data: '+JSON.stringify(queued.shift())+'\n\n'));return;}
    const part=await events.next();
    if(part.done){controller.close();return;}
    const event=await transform(part.value);
    if(cancelled)return;
    if(event){queued.push(event);controller.enqueue(encoder.encode('data: '+JSON.stringify(queued.shift())+'\n\n'));return;}
   }
  }catch(error){await events.return(undefined).catch(()=>{});if(!cancelled)controller.error(error);}
 },async cancel(){cancelled=true;await reader.cancel().catch(()=>{});await events.return(undefined);}});
 const headers=new Headers(upstream.headers);for(const name of ['content-length','content-encoding','etag'])headers.delete(name);
 return new Response(body,{status:upstream.status,headers});
}

export async function cleanupChatMedia(db:Database):Promise<number>{
 const paths=await db.rpc<string[]>('s2a_chat_media_expired',{});
 if(!Array.isArray(paths)||paths.length>20||paths.some(path=>!/^images\/imgtask_[a-f0-9]{32}\/image-1\.(png|jpg|webp)$/.test(path)))throw new HttpError(503,'invalid_chat_media_cleanup');
 let deleted=0;
 for(const path of paths){await deleteArtifacts(db,[path]);await db.rpc('s2a_chat_media_deleted',{p_path:path});deleted++;}
 return deleted;
}
