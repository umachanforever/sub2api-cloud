import './compat/wasm_exec.js';
import {HttpError} from './db.ts';

type Item=Record<string,any>;
type Runtime=typeof globalThis & {Go:new()=>{importObject:WebAssembly.Imports;run(instance:WebAssembly.Instance):Promise<void>};__s2aCompatCall(input:string):string};
type Call=(operation:string,body?:unknown,id?:string,reasoning?:Record<string,string>)=>any;
let pending:Promise<Call>|undefined;
async function converter():Promise<Call>{
  if(!pending)pending=(async()=>{
    const path=new URL('./compat/compat.wasm.gz',import.meta.url);
    const compressed=typeof Deno!=='undefined'?await Deno.readFile(path):await (await import('node:fs/promises')).readFile(path);
    const bytes=await new Response(new Response(compressed as BodyInit).body!.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    const runtime=globalThis as Runtime,go=new runtime.Go();
    const {instance}=await WebAssembly.instantiate(bytes,go.importObject);
    let failed=false;
    void go.run(instance).catch(()=>{failed=true;});
    if(typeof runtime.__s2aCompatCall!=='function')throw new HttpError(503,'protocol_converter_unavailable');
    return (operation,body,id,reasoning)=>{
      if(failed)throw new HttpError(503,'protocol_converter_unavailable');
      const result=JSON.parse(runtime.__s2aCompatCall(JSON.stringify({operation,body,id,reasoning})));
      if(result.error)throw new HttpError(result.error==='capacity'?503:400,result.error==='capacity'?'protocol_converter_busy':'invalid_protocol_conversion');
      return result.value;
    };
  })();
  try{return await pending;}catch{throw new HttpError(503,'protocol_converter_unavailable');}
}

const reasoningCache=new Map<string,{until:number;text:string}>();
const cacheKey=(scope:string,id:string)=>JSON.stringify([scope,id]);
function rememberedReasoning(scope:string,input:unknown):Record<string,string>{
  const result:Record<string,string>={};
  if(!Array.isArray(input))return result;
  for(const item of input){
    if(item?.type!=='reasoning'||typeof item.id!=='string')continue;
    const key=cacheKey(scope,item.id),stored=reasoningCache.get(key);
    if(stored&&stored.until>Date.now())result[item.id]=stored.text;else reasoningCache.delete(key);
  }
  return result;
}
function rememberReasoning(scope:string,event:Item){
  const items=event.type==='response.output_item.done'?[event.item]:event.response?.output??[];
  for(const item of items){
    if(item?.type!=='reasoning'||typeof item.id!=='string')continue;
    const text=Array.isArray(item.summary)?item.summary.filter((part:Item)=>typeof part?.text==='string').map((part:Item)=>part.text).join('\n'):'';
    if(!text||new TextEncoder().encode(text).length>65_536)continue;
    const key=cacheKey(scope,item.id);reasoningCache.delete(key);
    if(reasoningCache.size>=128)reasoningCache.delete(reasoningCache.keys().next().value!);
    reasoningCache.set(key,{until:Date.now()+7*24*60*60_000,text});
  }
}

async function* chatChunks(reader:ReadableStreamDefaultReader<Uint8Array>):AsyncGenerator<Item>{
  const decoder=new TextDecoder();let pending='';
  const parse=(frame:string)=>{
    const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    if(!data)return;
    if(data==='[DONE]')return {done:true};
    let value;try{value=JSON.parse(data);}catch{throw new HttpError(502,'invalid_upstream_stream');}
    if(!value||typeof value!=='object'||Array.isArray(value)||value.error||!Array.isArray(value.choices))throw new HttpError(502,'invalid_upstream_stream');
    return {value};
  };
  while(true){
    const {done,value}=await reader.read();pending+=decoder.decode(value,{stream:!done});
    let boundary:RegExpExecArray|null;
    while((boundary=/\r?\n\r?\n/.exec(pending))){
      if(boundary.index>1_048_576)throw new HttpError(502,'upstream_event_too_large');
      const frame=parse(pending.slice(0,boundary.index));pending=pending.slice(boundary.index+boundary[0].length);
      if(frame?.done)return;if(frame?.value)yield frame.value;
    }
    if(pending.length>1_048_576)throw new HttpError(502,'upstream_event_too_large');
    if(done){const frame=parse(pending);if(frame?.value)yield frame.value;return;}
  }
}

export type OriginalChatBridge={body:Item;close():void;response(upstream:Response):Response};
export async function originalChatBridge(body:Item,scope:string):Promise<OriginalChatBridge>{
  if(Array.isArray(body.input))rememberReasoning(scope,{response:{output:body.input}});
  const call=await converter(),opened=call('open_chat',body,undefined,rememberedReasoning(scope,body.input));
  let closed=false;
  const close=()=>{if(!closed){closed=true;try{call('close',undefined,opened.id);}catch{/* An unavailable runtime is discarded with its worker. */}}};
  return {
    body:{...opened.body,stream:true,stream_options:{include_usage:true}},close,
    response(upstream){
      if(!upstream.body){close();throw new HttpError(502,'invalid_upstream_response');}
      const reader=upstream.body.getReader(),encoder=new TextEncoder();
      const events=async function*():AsyncGenerator<Item>{
        try{
          if(upstream.headers.get('content-type')?.includes('application/json')){
            const chunks:Uint8Array[]=[];let size=0;
            while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>32*1024*1024)throw new HttpError(502,'upstream_response_too_large');chunks.push(value);}
            const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
            const value=JSON.parse(new TextDecoder().decode(bytes));
            if(!value||value.error||!Array.isArray(value.choices)||!value.choices.length||!value.choices[0]?.message)throw new HttpError(502,'invalid_upstream_response');
            const event={type:'response.completed',response:call('json_chat',value,opened.id)};
            rememberReasoning(scope,event);yield event;
          }else{
            const contentType=upstream.headers.get('content-type');
            if(contentType&&!contentType.includes('text/event-stream'))throw new HttpError(502,'invalid_upstream_stream');
            for await(const chunk of chatChunks(reader))for(const event of call('chunk_chat',chunk,opened.id)??[]){rememberReasoning(scope,event);yield event;}
            for(const event of call('finish_chat',undefined,opened.id)??[]){rememberReasoning(scope,event);yield event;}
          }
        }catch{
          let response;try{response=call('failure_chat',undefined,opened.id);}catch{response={object:'response',status:'failed',output:[],error:{code:'upstream_error',message:'Upstream generation failed'}};}
          yield {type:'response.failed',response};
        }
        finally{await reader.cancel().catch(()=>{});reader.releaseLock();close();}
      };
      const iterator=events();
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller){try{const next=await iterator.next();if(next.done)controller.close();else controller.enqueue(encoder.encode(`event: ${next.value.type}\ndata: ${JSON.stringify(next.value)}\n\n`));}catch(error){controller.error(error);}},
        async cancel(){await reader.cancel().catch(()=>{});await iterator.return(undefined);close();},
      }),{status:upstream.status,headers:{'content-type':'text/event-stream'}});
    },
  };
}

export async function originalChatBridgeCount():Promise<number>{return (await converter())('stats');}
