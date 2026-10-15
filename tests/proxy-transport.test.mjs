import assert from 'node:assert/strict';
import test from 'node:test';
import {fetchWithProxy,probeProxy} from '../supabase/functions/subscription-api/proxy_transport.ts';
const proxy={protocol:'socks5h',host:'::1',port:1080,username:'fixture',password:'fixture-password'};
test('native proxy fetch retains streaming clients and closes once on EOF, cancellation and fetch failure',async()=>{
 let closes=0;const create=options=>{assert.equal(options.proxy.url,'socks5h://[::1]:1080');assert.deepEqual(options.proxy.basicAuth,{username:proxy.username,password:proxy.password});return {close(){closes++;}};};
 const response=await fetchWithProxy(proxy,'https://provider.example',{},async(url,init)=>{assert.ok(init.client);return new Response('streamed');},create);assert.equal(closes,0);assert.equal(await response.text(),'streamed');assert.equal(closes,1);
 const other=await fetchWithProxy(proxy,'https://provider.example',{},async()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array([1]));}})),create);await other.body.cancel();assert.equal(closes,2);
 await assert.rejects(fetchWithProxy(proxy,'https://provider.example',{},async()=>{throw Error('failed');},create));assert.equal(closes,3);
});
test('proxy connectivity validates exit metadata and masks provider bodies and credentials',async()=>{
 let seen;
 const result=await probeProxy(proxy,new AbortController().signal,async(p,url,init)=>{seen={p,url,init};return Response.json({status:'success',query:'192.0.2.1',country:'Fixture',city:'x\r\ny',countryCode:'XX'});});
 assert.equal(result.success,true);assert.equal(result.ip_address,'192.0.2.1');assert.equal(result.city,undefined);assert.equal(seen.init.redirect,'error');assert.equal(seen.url,'http://ip-api.com/json/?lang=en');
 for(const send of [async()=>Response.json({status:'success',query:'not-an-ip'}),async()=>new Response('fixture-password',{status:407}),async()=>{throw Error('fixture-password');}]){
  const failed=await probeProxy(proxy,new AbortController().signal,send);assert.deepEqual(failed,{success:false,message:'Proxy connectivity check failed'});
 }
});
