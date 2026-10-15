import {HttpError} from './db.ts';
import {responseEvents} from './openai_protocol.ts';
type Item=Record<string,any>;

// Adapt Responses image tools without recording a separate driver-model request.
export async function imageResponses(upstream:Response,streaming:boolean):Promise<Response>{
  if(!upstream.body)throw new HttpError(502,'invalid_upstream_response');
  const type=upstream.headers.get('content-type');
  if(type&&!type.includes('text/event-stream')){await upstream.body.cancel();throw new HttpError(502,'invalid_upstream_stream');}
  let bytes=0;
  const bounded=upstream.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){bytes+=chunk.length;if(bytes>64*1024*1024)throw new HttpError(502,'upstream_response_too_large');controller.enqueue(chunk);}}));
  const reader=bounded.getReader();
  async function* events():AsyncGenerator<Item>{
    const pending=new Map<string,Item>();let completed=false;
    for await(const event of responseEvents(reader,16*1024*1024)){
      if(event.type==='error'||event.type==='response.failed'||event.type==='response.incomplete'||event.error)throw new HttpError(502,'image_generation_failed');
      if(event.type==='response.image_generation_call.partial_image'&&typeof event.partial_image_b64==='string')yield {type:'image_generation.partial_image',partial_image_index:event.partial_image_index,b64_json:event.partial_image_b64};
      if(event.type==='response.output_item.done'&&event.item?.type==='image_generation_call'&&typeof event.item.result==='string'&&event.item.result)pending.set(event.item.id??String(event.output_index),event.item);
      if(event.type!=='response.completed')continue;
      if(completed)throw new HttpError(502,'invalid_upstream_response');
      completed=true;const response=event.response;
      if(!response||response.status&&response.status!=='completed')throw new HttpError(502,'image_generation_failed');
      const final=Array.isArray(response.output)?response.output.filter((item:Item)=>item?.type==='image_generation_call'&&typeof item.result==='string'&&item.result):[];
      const images=final.length?final:[...pending.values()];
      if(!images.length)throw new HttpError(502,'image_generation_no_output');
      const tool=response.tools?.find((item:Item)=>item.type==='image_generation')??{};
      for(const [index,image] of images.entries()){
        const result:Item={type:'image_generation.completed',b64_json:image.result,created_at:response.created_at??Math.floor(Date.now()/1000)};
        for(const field of ['revised_prompt','output_format','size','background','quality','model'])if(image[field]??tool[field])result[field]=image[field]??tool[field];
        if(index===images.length-1)result.usage=response.usage;
        yield result;
      }
    }
    if(!completed)throw new HttpError(502,'incomplete_upstream_stream');
  }
  const iterator=events();
  if(!streaming){
    const data:Item[]=[];let created:number|undefined,usage:Item|undefined;
    for await(const event of iterator){if(event.type!=='image_generation.completed')continue;const {type,created_at,usage:eventUsage,...item}=event;data.push(item);created=created_at;usage=eventUsage??usage;}
    return Response.json({created,data,...(usage?{usage}:{})},{status:upstream.status});
  }
  const encoder=new TextEncoder();
  const body=new ReadableStream<Uint8Array>({async pull(controller){try{const part=await iterator.next();if(part.done)controller.close();else controller.enqueue(encoder.encode(`event: ${part.value.type}\ndata: ${JSON.stringify(part.value)}\n\n`));}catch(error){controller.error(error);}},async cancel(){await reader.cancel().catch(()=>{});await iterator.return(undefined);try{reader.releaseLock();}catch{/* The event iterator already released it. */}}});
  return new Response(body,{status:upstream.status,headers:{'content-type':'text/event-stream'}});
}
