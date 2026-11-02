import test from 'node:test';
import assert from 'node:assert/strict';
import {scheduledModelFilter,modelAvailabilityJobs} from '../supabase/functions/sub2api/model_availability_jobs.ts';
import {Database} from '../supabase/functions/sub2api/db.ts';
import {createBackendHandler} from './handler.mjs';
import {encryptCredentials} from '../supabase/functions/sub2api/credential_store.ts';

const config={url:'https://db.invalid',serviceKey:'service',encryptionKey:Buffer.alloc(32,7).toString('base64'),adminIds:[],dataModel:'native'};
const request=()=>new Request('https://gateway/v1beta/models',{headers:{authorization:'Bearer sk-client','x-real-ip':'192.0.2.1'}});
const listing=()=>Response.json({models:[{name:'models/gemini-good',displayName:'Keep'},{name:'models/claude-bad'}],nextPageToken:'next'},{headers:{etag:'unfiltered'}});

function queue(){
 const rows=new Map();let claims=0;
 const rpc=async(name,args)=>{
  if(name==='s2a_model_availability_read'){
   assert.equal(JSON.stringify(args).includes('sk-client'),false);
   assert.match(args.p_key_hash,/^[a-f0-9]{64}$/);
   return args.p_jobs.map(job=>{
    if(!rows.has(job.fingerprint))rows.set(job.fingerprint,{...job,key_hash:args.p_key_hash,native:args.p_native,platform:args.p_platform,client_ip:args.p_client_ip,verdict:'unverified',checked_at:null});
    return rows.get(job.fingerprint);
   });
  }
  if(name==='s2a_model_availability_claim'){
   claims++;
   return [...rows.values()].filter(row=>!row.checked_at).slice(0,6).map(row=>Object.assign(row,{lease_id:crypto.randomUUID()}));
  }
  if(name==='s2a_model_availability_finish'){
   const row=rows.get(args.p_fingerprint);assert.equal(row.lease_id,args.p_lease_id);
   Object.assign(row,{verdict:args.p_verdict,checked_at:new Date().toISOString()});return true;
  }
 };
 return {rows,rpc,get claims(){return claims;}};
}

test('client catalogs only read durable verdicts, with metadata, key and protocol isolation',async()=>{
 const state=queue();const db={rpc:state.rpc};
 const first=await scheduledModelFilter(listing(),request(),'sk-client',db,true);
 assert.deepEqual(await first.json(),{models:[],nextPageToken:'next'});
 assert.match(first.headers.get('x-s2a-model-verification'),/unverified=2/);
 assert.equal(first.headers.get('etag'),null);
 assert.equal(state.claims,0);
 for(const row of state.rows.values())Object.assign(row,{verdict:row.model==='gemini-good'?'verified':'unsupported',checked_at:new Date().toISOString()});
 const changedIp=await scheduledModelFilter(listing(),new Request('https://gateway/v1beta/models',{headers:{'x-real-ip':'192.0.2.2'}}),'sk-client',db,true);
 assert.equal((await changedIp.json()).models.length,1);
 // A new handler can use the same persisted results without warming any cache.
 const second=await scheduledModelFilter(listing(),request(),'sk-client',{rpc:state.rpc},true);
 assert.deepEqual((await second.json()).models,[{name:'models/gemini-good',displayName:'Keep'}]);
 for(const [token,native,req,body] of [
  ['different-key',true,request(),listing()],
  ['sk-client',false,request(),Response.json({models:[{name:'models/gemini-good',displayName:'Keep'}]})],
  ['sk-client',true,request(),Response.json({models:[{name:'models/gemini-good',displayName:'Changed'}]})],
 ])assert.deepEqual((await (await scheduledModelFilter(body,req,token,db,native)).json()).models,[]);
});

test('expired positives, invalid models and transient failures stay hidden without triggering inference',async()=>{
 let calls=0;
 const result=await scheduledModelFilter(Response.json({data:[{id:'gpt-custom'},{id:'gemini-expired'},{id:'gemini-temporary'},{id:'gemini-*'}]}),request(),'sk-client',{rpc:async(name,args)=>{
  calls++;assert.equal(name,'s2a_model_availability_read');assert.equal(args.p_jobs.length,2);
  return args.p_jobs.map(job=>({...job,verdict:job.model.includes('expired')?'verified':'temporary',checked_at:new Date(Date.now()-(job.model.includes('expired')?31*60_000:0)).toISOString()}));
 }},false);
 assert.equal(calls,1);assert.deepEqual((await result.json()).data,[{id:'gpt-custom'}]);
 assert.match(result.headers.get('x-s2a-model-verification'),/temporary=1; unsupported=0; unverified=2/);
});

test('signed jobs perform real inference and persist verdicts; later listings make no inference calls',async()=>{
 const state=queue();const stored=await encryptCredentials({api_key:'provider-key'},config.encryptionKey);
 const probes=[],finishes=[];
 const app=createBackendHandler(config,async(url,init)=>{
  const name=String(url).split('/').at(-1);
  if(name.startsWith('s2a_model_availability_'))return Response.json(await state.rpc(name,JSON.parse(init.body)));
  if(name==='s2a_personal_key_policy')return Response.json({platform:'gemini'});
  if(name==='s2a_personal_acquire')return Response.json({lease_id:crypto.randomUUID(),account:{...stored,id:'account',type:'apikey',platform:'gemini',credential_version:1}});
  if(name==='s2a_personal_finish'){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
  if(String(url).includes('/rpc/'))return Response.json(null);
  if(init.method==='GET')return listing();
  probes.push(String(url));assert.equal(init.headers.get('x-goog-api-key'),'provider-key');
  assert.equal(JSON.parse(init.body).generationConfig.maxOutputTokens,1024);
  return String(url).includes('gemini-good')?Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'OK'}]}}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:1}}):Response.json({error:{message:'not supported'}},{status:404});
 });
 assert.deepEqual((await (await app(request())).json()).models,[]);assert.equal(probes.length,0);
 const unauthorized=await app(new Request('https://gateway/internal/jobs/models',{method:'POST',headers:{authorization:'Bearer sk-client'}}));
 assert.equal(unauthorized.status,401);assert.equal(state.claims,0);
 const job=await app(new Request('https://gateway/internal/jobs/models',{method:'POST',headers:{authorization:'Bearer service'}}));
 assert.equal(job.status,200);assert.deepEqual(await job.json(),{claimed:2,finished:2});assert.equal(probes.length,2);
 assert.ok(finishes.some(row=>row.p_input_tokens===3&&row.p_output_tokens===1));
 assert.deepEqual((await (await app(request())).json()).models,[{name:'models/gemini-good',displayName:'Keep'}]);assert.equal(probes.length,2);
});

test('scheduled quota failures do not cool down the whole account, and a public header cannot bypass cooldown',async()=>{
 const state=queue(),stored=await encryptCredentials({api_key:'provider-key'},config.encryptionKey),finishes=[];
 await scheduledModelFilter(Response.json({models:[{name:'models/gemini-limited'}]}),request(),'sk-client',{rpc:state.rpc},true);
 const db=new Database(config,async(url,init)=>{
  const name=String(url).split('/').at(-1);
  if(name.startsWith('s2a_model_availability_'))return Response.json(await state.rpc(name,JSON.parse(init.body)));
  if(name==='s2a_personal_acquire')return Response.json({lease_id:crypto.randomUUID(),account:{...stored,id:'account',type:'apikey',platform:'gemini',credential_version:1}});
  if(name==='s2a_personal_finish'){finishes.push(JSON.parse(init.body));return Response.json({applied:true});}
  if(String(url).includes('/rpc/'))return Response.json(null);
  return Response.json({error:{message:'Model quota exhausted'}},{status:429});
 });
 await modelAvailabilityJobs(new Request('https://gateway/internal/jobs/models',{method:'POST',headers:{authorization:'Bearer service'}}),db);
 assert.equal([...state.rows.values()][0].verdict,'temporary');
 assert.ok(finishes.some(row=>row.p_status===429));assert.ok(finishes.every(row=>row.p_cooldown_seconds===0));
 const {proxy}=await import('../supabase/functions/sub2api/proxy.ts');
 await assert.rejects(proxy(new Request('https://gateway/v1beta/models/gemini-limited:generateContent',{method:'POST',headers:{'content-type':'application/json','x-s2a-model-probe':'true'},body:JSON.stringify({contents:[{parts:[{text:'Hello'}]}]})}),'/v1beta/models/gemini-limited:generateContent','sk-client',db,{requestId:crypto.randomUUID(),started:Date.now()}),error=>error.status===429);
 assert.ok(finishes.some(row=>row.p_status===429&&row.p_cooldown_seconds===60));
});

test('model scheduler accepts only its own short-lived signature scope',async()=>{
 const {createHmac}=await import('node:crypto');
 const signingKey='a'.repeat(64),state=queue();
 const db=new Database({...config,jobSigningKey:signingKey},async(url,init)=>Response.json(await state.rpc(String(url).split('/').at(-1),JSON.parse(init.body))));
 const ticket=Math.floor(Date.now()/1000)+60+':'+crypto.randomUUID();
 const signature=scope=>createHmac('sha256',signingKey).update('s2a-'+scope+':'+ticket).digest('hex');
 for(const scope of ['images','models']){
  const req=new Request('https://gateway/internal/jobs/models',{method:'POST',headers:{'x-s2a-models-job-token':ticket+':'+signature(scope)}});
  if(scope==='images')await assert.rejects(modelAvailabilityJobs(req,db),error=>error.status===401);
  else assert.equal((await modelAvailabilityJobs(req,db)).status,200);
 }
 assert.equal(state.claims,1);
});
