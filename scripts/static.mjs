import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.webp':'image/webp','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf'};
export async function serveStatic(request,response,pathname,directory){
  if(!directory||/^\/(api|v1|v1beta|setup)(?:\/|$)/.test(pathname))return false;
  if(!['GET','HEAD'].includes(request.method)){response.writeHead(405);response.end();return true;}
  const decoded=decodeURIComponent(pathname);
  if(decoded.includes('\0')||decoded.includes('\\')||decoded.split('/').includes('..')){response.writeHead(400);response.end();return true;}
  if(decoded.split('/').some(part=>part.startsWith('.'))){response.writeHead(404);response.end();return true;}
  const extension=extname(decoded),root=resolve(directory);
  if(extension&&!types[extension]){response.writeHead(404);response.end();return true;}
  const file=extension?resolve(root,`.${decoded}`):resolve(root,'index.html');
  if(!file.startsWith(root+sep)){response.writeHead(400);response.end();return true;}
  try{
    const contents=await readFile(file);
    response.writeHead(200,{'content-type':types[extension||'.html'],'x-content-type-options':'nosniff',
      'cache-control':decoded.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache'});
    response.end(request.method==='HEAD'?undefined:contents);
  }catch(error){if(error.code!=='ENOENT')throw error;response.writeHead(404);response.end();}
  return true;
}
