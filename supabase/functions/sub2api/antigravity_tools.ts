import {Database,HttpError} from './db.ts';
import {codeAssistFrames,normalizeCodeAssist} from './google_oauth.ts';
import {groundingText} from './antigravity_claude.ts';
import {chatImageMarkdown,IMAGE_CHAT_FRAME_LIMIT} from './chat_images.ts';
type Item=Record<string,any>;
export type AntigravityToolContext={db:Database;leaseId:string;images:boolean;signal:AbortSignal};
type Send=(envelope:Item,signal:AbortSignal)=>Promise<Response>;
const searchName='s2a_web_search',imageName='s2a_generate_image';
const usageFields=['promptTokenCount','candidatesTokenCount','thoughtsTokenCount','cachedContentTokenCount','totalTokenCount'];
function addUsage(total:Item,value:Item={}){for(const key of usageFields)if(Number.isSafeInteger(value[key])&&value[key]>=0)total[key]=(total[key]??0)+value[key];}
function argument(value:unknown,max:number):string{if(typeof value!=='string'||!value.trim()||value.length>max)throw new HttpError(502,'invalid_hosted_tool_arguments');return value.trim();}

export function enableAntigravityTools(envelope:Item,images:boolean):Set<string>{
 const body=envelope.request,names=new Set<string>();
 if(!body||!Array.isArray(body.contents))throw new HttpError(400,'invalid_request');
 if(String(envelope.model).includes('image')){
  if(!images)throw new HttpError(403,'image_generation_forbidden');
  body.generationConfig={...body.generationConfig,responseModalities:['TEXT','IMAGE']};return names;
 }
 const tools=body.tools??[],declarations=tools.flatMap((tool:Item)=>tool.functionDeclarations??[]);
 // Google rejects native grounding mixed with function declarations.
 if((body.generationConfig?.candidateCount??1)>1||declarations.length||tools.some((tool:Item)=>!Array.isArray(tool.functionDeclarations))||body.generationConfig?.responseMimeType==='application/json'||body.generationConfig?.responseSchema||body.generationConfig?.responseJsonSchema)return names;
 for(const [name,field,description,max] of [
  [searchName,'query','Search the web for current information and return verified sources.',4000],
  ...(images?[[imageName,'prompt','Generate or edit one image using Gemini. Describe the desired image in full.',16000]]:[]),
 ] as [string,string,string,number][]){
  if(declarations.some((tool:Item)=>tool.name===name))continue;
  names.add(name);declarations.push({name,description,parameters:{type:'object',properties:{[field]:{type:'string',description:`At most ${max} characters.`}},required:[field]}});
 }
 body.tools=declarations.length?[{functionDeclarations:declarations}]:[];
 if(!tools.length&&body.toolConfig?.functionCallingConfig?.mode==='NONE')body.toolConfig={...body.toolConfig,functionCallingConfig:{mode:'AUTO'}};
 const instructions=[
  names.has(searchName)?`Use ${searchName} for current news, time-sensitive facts and explicit web searches. Cite its source URLs. Do not claim to have searched without a successful tool result.`:'',
  names.has(imageName)?`When asked to create or edit an image, call ${imageName}. The gateway displays generated images automatically; acknowledge success without inventing image URLs. Never claim image generation is unavailable when this tool is offered, or claim success when it fails.`:'',
 ].filter(Boolean).join('\n');
 body.systemInstruction={...body.systemInstruction,parts:[...(body.systemInstruction?.parts??[]),{text:instructions}]};
 return names;
}

// Execute only the tools injected by this request; caller-owned functions stay client-owned.
export function antigravityHostedResponse(initial:Response,envelope:Item,names:Set<string>,send:Send,context:AntigravityToolContext):Response{
 const abort=new AbortController(),signal=AbortSignal.any([context.signal,abort.signal]),encoder=new TextEncoder();
 let reader:ReadableStreamDefaultReader<Item>|undefined;
 const totals:Item={},generated:string[]=[];let visibleText='';
 async function image(part:Item):Promise<string>{
  if(!context.images)throw new HttpError(403,'image_generation_forbidden');
  const data=part.inlineData??part.inline_data,mime=data?.mimeType??data?.mime_type;
  if(!['image/png','image/jpeg','image/webp'].includes(mime))throw new HttpError(502,'invalid_generated_image');
  const item={type:'image_generation_call',status:'completed',result:data.data,output_format:mime.slice(6)};
  // Match OpenAI chat output without requiring private storage or signed URL fetches.
  return chatImageMarkdown(item);
 }
 async function execute(call:Item):Promise<Item>{
  const generate=call.name===imageName,text=argument(call.args?.[generate?'prompt':'query'],generate?16000:4000);
  const reference=envelope.request.contents.filter((item:Item)=>item.role==='user').at(-1)?.parts?.filter((part:Item)=>part.inlineData||part.fileData)??[];
  const body={contents:[{role:'user',parts:[{text},...(generate?reference:[])]}],...(generate?{generationConfig:{responseModalities:['TEXT','IMAGE']}}:{tools:[{googleSearch:{}}],generationConfig:{maxOutputTokens:2048}})};
  const response=await send({...envelope,model:generate?'gemini-3.1-flash-image':'gemini-3-flash',requestType:generate?'agent':'web_search',request:body},signal);
  if(!response.ok){await response.body?.cancel();throw new HttpError(response.status===429?429:502,generate?'image_generation_failed':'web_search_failed');}
  const result=await (await normalizeCodeAssist(response,false,IMAGE_CHAT_FRAME_LIMIT)).json();addUsage(totals,result.usageMetadata);
  const candidate=result.candidates?.[0],parts:Item[]=candidate?.content?.parts??[];
  if(generate){
   const images=parts.filter(part=>part.inlineData||part.inline_data);if(!images.length||images.length>4)throw new HttpError(502,'image_generation_failed');
   let markdown='';for(const part of images)markdown+=await image(part);generated.push(markdown);
   // Deliver bytes to the client, not as megabytes of text in the parent model's context.
   return {image_generated:true};
  }
  const sources=groundingText({groundingChunks:candidate?.groundingMetadata?.groundingChunks});
  if(!sources)throw new HttpError(502,'web_search_no_sources');
  return {answer:parts.filter(part=>!part.thought&&typeof part.text==='string').map(part=>part.text).join(''),sources};
 }
 async function* events(){
  let response=initial,executed=0;
  for(let turn=0;turn<3;turn++){
   const parts:Item[]=[],calls:Item[]=[],roundUsage:Item={};let terminal=false,size=0;
   reader=codeAssistFrames(response,IMAGE_CHAT_FRAME_LIMIT).getReader();
   try{for(;;){
    const chunk=await reader.read();if(chunk.done)break;signal.throwIfAborted();
    const value=chunk.value;size+=JSON.stringify(value).length;if(size>IMAGE_CHAT_FRAME_LIMIT*2)throw new HttpError(502,'upstream_response_too_large');
    Object.assign(roundUsage,value.usageMetadata??{});
    for(const candidate of value.candidates??[]){
     const visible=[];
     for(const part of candidate.content?.parts??[]){
      if(part.text===''&&Object.keys(part).length===1)continue;
      parts.push(part);
      if(names.has(part.functionCall?.name)){calls.push(part.functionCall);if(calls.length>4)throw new HttpError(502,'hosted_tool_limit');}
      else if(part.inlineData||part.inline_data)visible.push({text:await image(part)});
      else visible.push(part);
     }
     visibleText+=visible.filter(part=>!part.thought&&typeof part.text==='string').map(part=>part.text).join('');
     // Deliver generated images even when the parent model omits them from its answer.
     if(candidate.finishReason&&!calls.length)for(const markdown of generated)if(!visibleText.includes(markdown)){visible.push({text:markdown});visibleText+=markdown;}
     if(candidate.content||visible.length)candidate.content={...candidate.content,role:'model',parts:visible};
     if(candidate.finishReason)terminal=true;
     if(calls.length)delete candidate.finishReason;
    }
    if(value.promptFeedback?.blockReason)terminal=true;
    if(value.usageMetadata){const usage={...totals};addUsage(usage,roundUsage);value.usageMetadata=usage;}
    yield encoder.encode('data: '+JSON.stringify({response:value})+'\n\n');
   }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();reader=undefined;}
   if(!terminal)throw new HttpError(502,'incomplete_upstream_response');
   if(!calls.length)return;
   if(turn===2||executed+calls.length>4)throw new HttpError(502,'hosted_tool_limit');
   addUsage(totals,roundUsage);const results=[];
   for(const call of calls){signal.throwIfAborted();results.push({functionResponse:{name:call.name,...(call.id?{id:call.id}:{}),response:await execute(call)}});executed++;}
   envelope={...envelope,request:{...envelope.request,contents:[...envelope.request.contents,{role:'model',parts},{role:'user',parts:results}]}};
   signal.throwIfAborted();response=await send(envelope,signal);
   if(!response.ok){await response.body?.cancel();throw new HttpError(response.status===429?429:502,'hosted_tool_completion_failed');}
  }
 }
 const iterator=events();let cancelled=false;
 return new Response(new ReadableStream<Uint8Array>({async pull(controller){try{const next=await iterator.next();if(cancelled)return;if(next.done)controller.close();else controller.enqueue(next.value);}catch(error){console.error('antigravity_hosted_failure',error instanceof HttpError?error.code:'unexpected_error');if(!cancelled)controller.error(error);}},async cancel(){cancelled=true;abort.abort();await reader?.cancel().catch(()=>{});await iterator.return(undefined);}}),{headers:{'content-type':'text/event-stream'}});
}
