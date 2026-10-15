import { HttpError } from "./db.ts";

export async function catalogJSON(response:Response,allowArray=false,limit=8*1024*1024):Promise<Record<string,unknown>> {
  if(!response.ok){await response.body?.cancel();throw new HttpError(502,[404,405].includes(response.status)?"upstream_model_list_unsupported":"upstream_model_list_failed");}
  const reader=response.body?.getReader();if(!reader)throw new HttpError(502,"invalid_upstream_model_catalog");
  let size=0;const chunks:Uint8Array[]=[];
  try {
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new HttpError(502,"upstream_model_catalog_too_large");chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const value=JSON.parse(new TextDecoder().decode(bytes));
    if(!value || typeof value!=="object" || (!allowArray && Array.isArray(value)) || value.error)throw new HttpError(502,"invalid_upstream_model_catalog");
    return value;
  } catch(error){if(error instanceof HttpError)throw error;throw new HttpError(502,"invalid_upstream_model_catalog");}
  finally {await reader.cancel();}
}
