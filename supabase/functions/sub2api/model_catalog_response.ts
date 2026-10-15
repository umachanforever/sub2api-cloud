export async function codexManifestResponse(manifest:unknown,request:Request):Promise<Response>{
  const serialized=JSON.stringify(manifest),digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(serialized));
  const etag='"'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')+'"';
  const matched=request.headers.get('if-none-match')?.split(',').some(value=>value.trim()==='*'||value.trim().replace(/^W\//,'')===etag);
  return new Response(matched?null:serialized,{status:matched?304:200,headers:{etag,'cache-control':'no-store',...(matched?{}:{'content-type':'application/json'})}});
}
