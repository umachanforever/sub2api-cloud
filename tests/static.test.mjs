import assert from 'node:assert/strict';import test from 'node:test';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {serveStatic} from '../scripts/static.mjs';
test('production console serves the original SPA and assets without exposing local secrets',async()=>{
 const root=await mkdtemp(join(tmpdir(),'s2a-static-'));try{
  await writeFile(join(root,'index.html'),'<html>original frontend</html>');await writeFile(join(root,'.env'),'PRIVATE');await mkdir(join(root,'assets'));await writeFile(join(root,'assets','app.js'),'console.log(1)');
  const request=async(path,method='GET')=>{const r={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}};
   const handled=await serveStatic({method},r,path,root);return {...r,handled};};
  const page=await request('/admin/accounts');assert.equal(page.status,200);assert.match(page.body.toString(),/original frontend/);
  const asset=await request('/assets/app.js');assert.equal(asset.status,200);assert.match(asset.headers['cache-control'],/immutable/);
  assert.equal((await request('/.env')).status,404);assert.equal((await request('/assets/%2e%2e/%2e%2e/secrets.js')).status,400);
  assert.equal((await request('/api/v1/auth/me')).handled,false);assert.equal((await request('/login','POST')).status,405);
  assert.equal((await request('/admin/accounts','HEAD')).body,undefined);
 }finally{await rm(root,{recursive:true,force:true});}
});
