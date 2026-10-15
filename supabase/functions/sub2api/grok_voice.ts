import {HttpError} from './db.ts';
import {trackedStream,type Usage} from './stream.ts';

// Preserve multipart boundaries and binary audio without interpreting uploads as JSON.
export async function voiceUpload(request:Request,limit:number):Promise<Uint8Array>{
  const length=request.headers.get('content-length');
  if(length&&/^\d+$/.test(length)&&Number(length)>limit){await request.body?.cancel();throw new HttpError(413,'request_too_large');}
  if(!request.body)throw new HttpError(400,'audio_input_required');
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>limit)throw new HttpError(413,'request_too_large');chunks.push(part.value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  if(!size)throw new HttpError(400,'audio_input_required');
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
export function voiceResponse(upstream:Response,signal:AbortSignal,finish:(status:number,usage:Usage)=>Promise<void>):Response{
  if(!upstream.body)throw new HttpError(502,'invalid_upstream_response');
  const headers=new Headers({'cache-control':'no-store','x-content-type-options':'nosniff'});
  for(const name of ['content-type','content-disposition']){const value=upstream.headers.get(name);if(value)headers.set(name,value);}
  const usage:Usage={input:null,output:null,cacheCreation:null,cacheRead:null,outcome:'incomplete'};
  let bytes=0;
  const body=trackedStream(upstream.body,signal,(value)=>finish(upstream.status,value),{
    usage,push(chunk){bytes+=chunk.length;},end(){if(!bytes)throw new HttpError(502,'invalid_upstream_response');usage.outcome='completed';},
  });
  return new Response(body,{status:upstream.status,headers});
}
