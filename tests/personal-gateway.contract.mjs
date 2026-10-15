import assert from 'node:assert/strict';
import {proxy} from '../supabase/functions/sub2api/proxy.ts';
const fixture=await new Response(Deno.stdin.readable).json();
assert.match(fixture.container,/^s2a-go-pg-[0-9a-f]+$/);
const signatures={
 s2a_personal_acquire:{p_key_hash:'text',p_model:'text',p_request_id:'uuid',p_excluded:'bigint[]',p_count_request:'boolean',p_client_ip:'text',p_billing_context:'jsonb'},
 s2a_personal_finish:{p_lease_id:'uuid',p_status:'integer',p_outcome:'text',p_input_tokens:'integer',p_output_tokens:'integer',p_cache_creation_tokens:'integer',p_cache_read_tokens:'integer',p_cooldown_seconds:'integer',p_credential_version:'bigint',p_first_token_ms:'integer',p_upstream_model:'text'},
};
let dispatched=0;
const db={
 config:{dataModel:'native',encryptionKey:''},
 async rpc(name,body){
  const signature=signatures[name];assert.ok(signature,'unexpected gateway RPC');
  for(const key of Object.keys(body))assert.ok(Object.hasOwn(signature,key));
  const args=Object.entries(signature).map(([key,type])=>`${key}=>`+(type==='jsonb'?`nullif(doc->'${key}','null'::jsonb)`:type==='bigint[]'?`ARRAY(SELECT jsonb_array_elements_text(doc->'${key}'))::bigint[]`:`(doc->>'${key}')::${type}`)).join(',');
  const literal="'"+JSON.stringify(body).replaceAll("'","''")+"'::jsonb";
  const child=new Deno.Command('docker',{args:['exec','-i',fixture.container,'psql','-qAt','-U','postgres','-v','ON_ERROR_STOP=1'],stdin:'piped',stdout:'piped',stderr:'piped'}).spawn();
  const writer=child.stdin.getWriter();await writer.write(new TextEncoder().encode(`SET standard_conforming_strings=on; SET ROLE service_role; SELECT public.${name}(${args})::text FROM (SELECT ${literal} AS doc) payload;`));await writer.close();
  const output=await child.output();assert.equal(output.success,true,new TextDecoder().decode(output.stderr));
  return JSON.parse(new TextDecoder().decode(output.stdout).trim());
 },
 async fetchImpl(url,init){
  if(url==='https://api.openai.com/v1/models')return Response.json({object:'list',data:[{id:'gpt-5.4',object:'model',owned_by:'openai'}]});
  assert.equal(url,'https://api.openai.com/v1/responses');
  assert.equal(new Headers(init.headers).get('authorization'),'Bearer synthetic-personal-token');
  const body=JSON.parse(init.body);assert.equal(body.model,'gpt-5.4');dispatched++;
  const response={object:'response',status:'completed',model:'gpt-5.4',usage:{input_tokens:100,output_tokens:20,input_tokens_details:{cached_tokens:40}},output:[]};
  return body.stream?new Response(`data: ${JSON.stringify({type:'response.completed',response})}\n\n`,{headers:{'content-type':'text/event-stream'}}):Response.json(response);
 },
};
for(const stream of [false,true]){
 const id=crypto.randomUUID();
 const response=await proxy(new Request('https://gateway.example.invalid/v1/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'personal-alias',input:'synthetic request',stream})}),'/v1/responses',fixture.key,db,{requestId:id,started:Date.now()});
 assert.equal(response.status,200);assert.ok((await response.text()).includes(stream?'response.completed':'"object":"response"'));
}
const catalog=await proxy(new Request('https://gateway.example.invalid/v1/models'),'/v1/models',fixture.key,db,{requestId:crypto.randomUUID(),started:Date.now()});
assert.equal(catalog.status,200);assert.ok((await catalog.json()).data.some(x=>x.id==='gpt-5.4'));
assert.equal(dispatched,2);
console.log('Personal gateway HTTP acceptance passed: native credentials, model mapping, JSON, SSE, and raw usage');
