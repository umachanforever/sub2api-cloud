import assert from 'node:assert/strict';
import test from 'node:test';
import {ProviderProtocolCatalog,parseProviderProtocolCatalog,readProviderProtocolCatalog} from '../supabase/functions/sub2api/provider_protocol_catalog.ts';
import {providerProtocol} from '../supabase/functions/sub2api/provider_routing.ts';

const signal=()=>new AbortController().signal;
const catalog=(protocol='responses')=>new Map([['model',[protocol]]]);
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('provider catalogs normalize endpoint paths, preserve priority, skip unknown fields and accept original list envelopes',()=>{
  const rows=[{id:' MODEL ',supported_endpoints:[' /v1/messages/ ','/responses','/v1/responses','/chat/completions','/other']},{id:'invalid',supported_endpoints:['unknown']},null];
  for(const value of [rows,{data:rows},{models:rows}])assert.deepEqual([...parseProviderProtocolCatalog(value)],[['model',['anthropic','responses','chat_completions']]]);
  for(const value of [null,{},[],{data:[{id:'model'}]}])assert.throws(()=>parseProviderProtocolCatalog(value));
});

test('catalog protocols follow original rule, catalog and built-in precedence',()=>{
  assert.equal(providerProtocol('command_code',{},'responses','deepseek-test',['chat_completions','responses']),'responses');
  assert.equal(providerProtocol('command_code',{},'chat_completions','gpt-test',['chat_completions']),'chat_completions');
  assert.equal(providerProtocol('command_code',{},'anthropic','gpt-test',['chat_completions','responses']),'responses');
  assert.equal(providerProtocol('command_code',{protocol_rules:[{pattern:'gpt-*',protocol:'anthropic'}]},'responses','gpt-test',['responses']),'anthropic');
  assert.equal(providerProtocol('command_code',{protocol_rules:[]},'responses','deepseek-test',['responses']),'responses');
  assert.equal(providerProtocol('command_code',{api_protocol:'chat_completions'},'responses','gpt-test',['responses']),'chat_completions');
});

test('catalog reads reject HTTP failures and oversized responses while closing the stream',async()=>{
  let cancelled=false;
  await assert.rejects(readProviderProtocolCatalog(new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(2*1024*1024+1));},cancel(){cancelled=true;}}))));
  assert.equal(cancelled,true);
  await assert.rejects(readProviderProtocolCatalog(Response.json({error:'private upstream detail'},{status:401})),/request failed/);
  assert.deepEqual([...await readProviderProtocolCatalog(Response.json({data:[{id:'model',supported_endpoints:['/responses']}]}))],[['model',['responses']]]);
});

test('concurrent cold requests share one refresh, then reuse a thirty-minute catalog',async()=>{
  let now=10_000,calls=0,resolve;
  const cache=new ProviderProtocolCatalog(()=>now),load=()=>{calls++;return new Promise(done=>{resolve=done;});};
  const first=cache.lookup('account-v1','MODEL',signal(),load),second=cache.lookup('account-v1','model',signal(),load);
  await flush();assert.equal(calls,1);resolve(catalog());
  assert.deepEqual(await first,['responses']);assert.deepEqual(await second,['responses']);
  now+=29*60_000;assert.deepEqual(await cache.lookup('account-v1','model',signal(),load),['responses']);assert.equal(calls,1);
});

test('stale catalogs remain usable during refresh and failures back off without clearing them',async()=>{
  let now=10_000,calls=0,reject;
  const cache=new ProviderProtocolCatalog(()=>now);
  await cache.lookup('account','model',signal(),async()=>catalog());
  now+=30*60_000;
  const fail=()=>{calls++;return new Promise((_,failure)=>{reject=failure;});};
  assert.deepEqual(await cache.lookup('account','model',signal(),fail),['responses']);
  await flush();assert.equal(calls,1);reject(Error('private upstream failure'));await flush();
  now+=4*60_000;assert.deepEqual(await cache.lookup('account','model',signal(),fail),['responses']);assert.equal(calls,1);
  now+=60_000;assert.deepEqual(await cache.lookup('account','model',signal(),async()=>{calls++;return catalog('anthropic');}),['responses']);
  await flush();assert.deepEqual(await cache.lookup('account','model',signal(),fail),['anthropic']);assert.equal(calls,2);
});

test('cold failure backoff is isolated by account and credential version',async()=>{
  let now=10_000,calls=0;
  const cache=new ProviderProtocolCatalog(()=>now),fail=async()=>{calls++;throw Error('private');};
  assert.deepEqual(await cache.lookup('account-v1','model',signal(),fail),[]);
  assert.deepEqual(await cache.lookup('account-v1','model',signal(),fail),[]);assert.equal(calls,1);
  assert.deepEqual(await cache.lookup('account-v2','model',signal(),async()=>catalog()),['responses']);
  assert.deepEqual(await cache.lookup('other-account','model',signal(),async()=>catalog('anthropic')),['anthropic']);
  now+=5*60_000;assert.deepEqual(await cache.lookup('account-v1','model',signal(),async()=>catalog()),['responses']);
});

test('cold requests share a deadline and cancellation leaves shared refresh running',async()=>{
  let now=10_000,resolve,calls=0;
  const cache=new ProviderProtocolCatalog(()=>now),abort=new AbortController(),load=()=>{calls++;return new Promise(done=>{resolve=done;});};
  const first=cache.lookup('account','model',abort.signal,load);await flush();now+=2001;
  assert.deepEqual(await cache.lookup('account','model',signal(),load),[]);assert.equal(calls,1);
  abort.abort();assert.deepEqual(await first,[]);resolve(catalog());await flush();
  assert.deepEqual(await cache.lookup('account','model',signal(),load),['responses']);
});
