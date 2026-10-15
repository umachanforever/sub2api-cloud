import {HttpError} from './db.ts';
import {trackedStream,type Usage} from './stream.ts';

// Match the original gateway's single official signed-video host allowlist.
export function signedVideoURL(raw:unknown,upstreamId:string):string|undefined{
 if(raw===undefined||raw===null||raw==='')return undefined;
 if(typeof raw!=='string')throw new HttpError(502,'invalid_video_content_url');
 let url:URL;
 try{url=new URL(raw,'https://relay.invalid');}catch{throw new HttpError(502,'invalid_video_content_url');}
 const segments=url.pathname.split('/').filter(Boolean);
 if(segments.at(-3)==='videos'&&segments.at(-1)==='content'){
  try{if(decodeURIComponent(segments.at(-2)!)===upstreamId)return undefined;}catch{throw new HttpError(502,'invalid_video_content_url');}
 }
 if(!/^https:\/\//i.test(raw.trim()))throw new HttpError(502,'invalid_video_content_url');
 if(url.protocol!=='https:'||url.hostname!=='vidgen.x.ai'||url.port&&url.port!=='443'||url.username||url.password||url.hash)throw new HttpError(502,'invalid_video_content_url');
 return url.href;
}
export function videoRange(request:Request):string|undefined{
 const range=request.headers.get('range')?.trim();
 if(!range)return undefined;
 if(range.length>512||!/^bytes=(?:\d+-\d*|-\d+)(?:,\s*(?:\d+-\d*|-\d+))*$/.test(range))throw new HttpError(400,'invalid_video_range');
 return range;
}
export function videoContentResponse(upstream:Response,signal:AbortSignal,finish:(status:number,usage:Usage)=>Promise<void>):Response{
 const source=upstream.body??(upstream.status===416?new ReadableStream<Uint8Array>({start(controller){controller.close();}}):undefined);
 if(!source)throw new HttpError(502,'invalid_video_content');
 const headers=new Headers({'cache-control':'no-store','x-content-type-options':'nosniff'});
 for(const name of ['content-type','content-length','content-range','accept-ranges','content-disposition']){const value=upstream.headers.get(name);if(value)headers.set(name,value);}
 if(!headers.has('content-type'))headers.set('content-type','application/octet-stream');
 const usage:Usage={input:null,output:null,cacheCreation:null,cacheRead:null,outcome:'incomplete'};
 const reader=source.getReader();
 const sanitized=new ReadableStream<Uint8Array>({
  async pull(controller){try{const {done,value}=await reader.read();if(done){reader.releaseLock();controller.close();}else controller.enqueue(value);}catch{await reader.cancel().catch(()=>{});controller.error(new Error('video_download_failed'));}},
  async cancel(){await reader.cancel().catch(()=>{});},
 });
 const stream=trackedStream(sanitized,signal,value=>finish(upstream.status,value),{usage,push(){},end(){usage.outcome='completed';}});
 return new Response(stream,{status:upstream.status,headers});
}
export function publicVideoContentURL(request:Request,id:string):string{
 const url=new URL(request.url);
 url.pathname=url.pathname.replace(/\/videos(?:\/.*)?$/,'/videos/'+id+'/content');url.search='';url.hash='';
 return url.href;
}
