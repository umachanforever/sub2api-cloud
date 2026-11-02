/** Keep idle HTTP streams alive without inventing model output or completion. */
export function sseHeartbeat(body:ReadableStream<Uint8Array>,intervalMs=15_000):ReadableStream<Uint8Array>{
 const reader=body.getReader(),heartbeat=new TextEncoder().encode(': keep-alive\n\n');
 type Result={part:ReadableStreamReadResult<Uint8Array>}|{error:unknown}|{idle:true};
 let pending:Promise<Result>|undefined,timer:ReturnType<typeof setTimeout>|undefined,stopped=false;
 const clear=()=>{if(timer!==undefined){clearTimeout(timer);timer=undefined;}};
 return new ReadableStream<Uint8Array>({
  async pull(controller){
   try{
    pending??=reader.read().then(part=>({part}),error=>({error}));
    const idle=new Promise<Result>(resolve=>{timer=setTimeout(()=>resolve({idle:true}),intervalMs);});
    const result=await Promise.race([pending,idle]);clear();
    if(stopped)return;
    if('idle'in result){controller.enqueue(heartbeat);return;}
    pending=undefined;
    if('error'in result)throw result.error;
    if(result.part.done){stopped=true;reader.releaseLock();controller.close();}
    else controller.enqueue(result.part.value);
   }catch(error){clear();if(!stopped){stopped=true;reader.releaseLock();controller.error(error);}}
  },
  async cancel(reason){
   stopped=true;clear();
   try{await reader.cancel(reason);}finally{reader.releaseLock();}
  },
 });
}
