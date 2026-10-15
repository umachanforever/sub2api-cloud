// Retain the dispatched path without provider hostnames, credentials, or queries.
export function usageEndpoint(url:string):string|null{
 try{
  const path=new URL(url).pathname;
  return path.length<=128&&/^\/[a-zA-Z0-9_/:.%-]+$/.test(path)?path:null;
 }catch{return null;}
}
