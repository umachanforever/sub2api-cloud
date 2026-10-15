import type {ProviderProtocol} from './provider_routing.ts';

type Catalog=Map<string,ProviderProtocol[]>;
type Entry={models?:Catalog;fetchedAt:number;retryAt:number;deadline:number;refresh?:Promise<void>};
export function parseProviderProtocolCatalog(value:unknown):Catalog{
  const document=value as {data?:unknown;models?:unknown};
  const rows=Array.isArray(value)?value:document?.data??document?.models;
  if(!Array.isArray(rows))throw Error('Invalid provider catalog');
  const models:Catalog=new Map();
  for(const row of rows){
    if(!row||typeof row.id!=='string'||!row.id.trim()||!Array.isArray(row.supported_endpoints))continue;
    const protocols:ProviderProtocol[]=[];
    for(const endpoint of row.supported_endpoints){
      if(typeof endpoint!=='string')continue;
      const path=endpoint.trim().toLowerCase().replace(/\/+$/,'');
      const protocol=path.endsWith('/chat/completions')?'chat_completions':path.endsWith('/responses')?'responses':path.endsWith('/messages')?'anthropic':undefined;
      if(protocol&&!protocols.includes(protocol))protocols.push(protocol);
    }
    if(protocols.length)models.set(row.id.trim().toLowerCase(),protocols);
  }
  if(!models.size)throw Error('Provider catalog has no supported endpoints');
  return models;
}

export async function readProviderProtocolCatalog(response:Response):Promise<Catalog>{
  if(!response.ok||!response.body){await response.body?.cancel();throw Error('Provider catalog request failed');}
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024)throw Error('Provider catalog too large');chunks.push(value);}
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return parseProviderProtocolCatalog(JSON.parse(new TextDecoder().decode(bytes)));
}

// Isolate caches by handler/database; entry keys contain account versions, never secrets.
export class ProviderProtocolCatalog{
  private entries=new Map<string,Entry>();
  private now:()=>number;
  private firstWait:number;
  constructor(now=Date.now,firstWait=2000){this.now=now;this.firstWait=firstWait;}
  async lookup(key:string,model:string,signal:AbortSignal,load:()=>Promise<Catalog>):Promise<ProviderProtocol[]>{
    if(signal.aborted)return [];
    let entry=this.entries.get(key);
    if(!entry){
      if(this.entries.size>=32){const idle=[...this.entries].find(([,value])=>!value.refresh);if(!idle)return [];this.entries.delete(idle[0]);}
      entry={fetchedAt:0,retryAt:0,deadline:0};this.entries.set(key,entry);
    }
    const current=entry,now=this.now();
    if((!current.models||now-current.fetchedAt>=30*60_000)&&!current.refresh&&now>=current.retryAt){
      current.deadline=now+this.firstWait;
      current.refresh=Promise.resolve().then(load).then(models=>{current.models=models;current.fetchedAt=this.now();current.retryAt=0;},()=>{current.retryAt=this.now()+5*60_000;}).finally(()=>{current.refresh=undefined;});
      (globalThis as typeof globalThis & {EdgeRuntime?:{waitUntil(task:Promise<unknown>):void}}).EdgeRuntime?.waitUntil(current.refresh);
    }
    if(!current.models&&current.refresh&&this.now()<current.deadline){
      let timer:ReturnType<typeof setTimeout>|undefined;
      let onAbort:()=>void=()=>{};
      const waiting=new Promise<void>(resolve=>{onAbort=()=>resolve();timer=setTimeout(resolve,Math.max(0,current.deadline-this.now()));signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)resolve();});
      try{await Promise.race([current.refresh,waiting]);}finally{clearTimeout(timer);signal.removeEventListener('abort',onAbort);}
    }
    return signal.aborted?[]:[...(current.models?.get(model.trim().toLowerCase())??[])];
  }
}
