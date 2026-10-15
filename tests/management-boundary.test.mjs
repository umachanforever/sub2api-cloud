import assert from 'node:assert/strict';
import test from 'node:test';
import {createConsoleServer,validateConfig} from '../scripts/console.mjs';
import {createHandler} from './handler.mjs';
const config={supabase_url:'https://project.supabase.co',publishable_key:'sb_publishable_12345678901234567890',management_url:'http://127.0.0.1:8080'};
async function consoleTest(fetchImpl,run){
 const server=createConsoleServer({config,fetchImpl});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{await run(`http://127.0.0.1:${server.address().port}`);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
test('management mutations retain native integer identifiers and never call Edge',async()=>{
 await consoleTest(async(url,init)=>{
  assert.equal(url,'http://127.0.0.1:8080/api/v1/admin/accounts/42');
  assert.equal(init.method,'PUT');assert.equal(init.headers.authorization,'Bearer session');
  assert.deepEqual(JSON.parse(init.body),{priority:7});
  return Response.json({code:0,data:{id:42,priority:7}});
 },async base=>{
  const r=await fetch(base+'/api/v1/admin/accounts/42',{method:'PUT',headers:{authorization:'Bearer session','content-type':'application/json'},body:JSON.stringify({priority:7})});
  assert.equal(r.status,200);assert.equal((await r.json()).data.id,42);
 });
});
test('management outages do not fall back to the retired cloud administration API',async()=>{
 let calls=0;
 await consoleTest(async url=>{calls++;assert.ok(String(url).startsWith(config.management_url));throw Error('offline');},async base=>{
  assert.equal((await fetch(base+'/api/v1/admin/accounts')).status,502);assert.equal(calls,1);
 });
});
test('Edge refuses all retired management routes without reading or changing business records',async()=>{
 const handler=createHandler({url:config.supabase_url,serviceKey:'secret',encryptionKey:'unused',adminIds:[]},()=>{throw Error('unexpected database access');});
 for(const method of ['GET','POST','PUT','DELETE']){
  const r=await handler(new Request('https://edge/functions/v1/subscription-api/api/v1/admin/accounts',{method,headers:{authorization:'Bearer session'}}));
  assert.equal(r.status,404);
 }
});
test('management endpoints must remain local with no embedded credentials or URL suffixes',()=>{
 for(const management_url of ['https://remote.example','http://evil.example','http://user:password@localhost:8080','http://localhost:8080/api','http://localhost:8080?token=secret'])assert.throws(()=>validateConfig({...config,management_url}),/invalid_management_url/);
 assert.equal(validateConfig({...config,management_url:'http://management:8080'}).management_url,'http://management:8080');
});
