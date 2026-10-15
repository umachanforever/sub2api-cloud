import assert from 'node:assert/strict';
import test from 'node:test';
import {createHmac} from 'node:crypto';
import {runMailJobs} from '../supabase/functions/sub2api/ops_mail.ts';
import {Database} from '../supabase/functions/sub2api/db.ts';
import {createHandler} from './handler.mjs';
import {mailSecrets} from '../scripts/deploy.mjs';
const id='11111111-1111-4111-8111-111111111111',config={url:'https://db',serviceKey:'private-key',encryptionKey:'',adminIds:[id]};
test('mail jobs isolate per-delivery failures and bind completion to the claimed lease',async()=>{
 const jobs=[{id:'a',lease_id:'lease-a',recipient:'a@example.com',payload:[]},{id:'b',lease_id:'lease-b',recipient:'b@example.com',payload:[]}],finishes=[];
 const db=new Database(config,async(url,init)=>{
  if(String(url).endsWith('s2a_ops_mail_claim'))return Response.json(jobs);
  finishes.push(JSON.parse(init.body));return Response.json(true);
 });
 const result=await runMailJobs(db,async delivery=>{if(delivery.id==='a')throw Error('provider-secret');});
 assert.deepEqual(result,{claimed:2,delivered:1});assert.deepEqual(finishes.find(f=>f.p_id==='a'),{p_id:'a',p_lease:'lease-a',p_error:'delivery_failed'});
 assert.equal(finishes.find(f=>f.p_id==='b').p_error,null);
});
test('mail route authorizes before claiming and disables claims when no transport is configured',async()=>{
 let calls=0;
 const handler=createHandler(config,async(url)=>{assert.ok(String(url).endsWith('s2a_smtp_worker_config'));calls++;return Response.json({smtp_host:''});});
 const request=token=>new Request('https://gateway/internal/jobs/mail',{method:'POST',headers:{authorization:'Bearer '+token}});
 assert.equal((await handler(request('bad'))).status,401);
 const expiry=Math.floor(Date.now()/1000)+60,nonce=crypto.randomUUID(),ticket=`${expiry}:${nonce}`;
 const signed=scope=>ticket+':'+createHmac('sha256',config.serviceKey).update(`s2a-${scope}:${ticket}`).digest('hex');
 const scoped=scope=>new Request('https://gateway/internal/jobs/mail',{method:'POST',headers:{'x-s2a-mail-job-token':signed(scope)}});
 assert.equal((await handler(scoped('privacy'))).status,401);assert.equal((await handler(scoped('mail'))).status,200);
 const response=await handler(request(config.serviceKey));assert.deepEqual(await response.json(),{enabled:false,claimed:0,delivered:0});assert.equal(calls,2);
});
test('HTTP transport uses a stable idempotency key and marks success only after a receipt',async()=>{
 const job={id:'delivery-id',lease_id:'lease-id',recipient:'fixture@example.com',payload:[{title:'Fixture'}]};let finish;
 const handler=createHandler({...config,mail:{apiKey:'fixture-key',from:'ops@example.com'}},async(url,init)=>{
  if(String(url).endsWith('s2a_smtp_worker_config'))return Response.json({smtp_host:''});
  if(String(url).endsWith('s2a_ops_mail_claim'))return Response.json([job]);
  if(String(url)==='https://api.resend.com/emails'){assert.equal(init.headers['idempotency-key'],job.id);assert.deepEqual(JSON.parse(init.body).to,[job.recipient]);return Response.json({id:'receipt'});}
  assert.ok(String(url).endsWith('s2a_ops_mail_finish'));finish=JSON.parse(init.body);return Response.json(true);
 });
 const response=await handler(new Request('https://gateway/internal/jobs/mail',{method:'POST',headers:{authorization:'Bearer '+config.serviceKey}}));
 assert.equal((await response.json()).delivered,1);assert.equal(finish.p_error,null);
});

test('saved SMTP takes priority, binds claims and never falls back after submission failure',async()=>{
 const job={id:'smtp-delivery',lease_id:'lease',recipient:'fixture@example.com',payload:[{title:'Fixture'}]};let claims=0,finishes=0,sends=0;
 const handler=createHandler({...config,mail:{apiKey:'fixture',from:'ops@example.com'}},async(url,init)=>{
  if(String(url).endsWith('s2a_smtp_worker_config'))return Response.json({smtp_host:'localhost',smtp_port:2525,smtp_from_email:'ops@example.com',smtp_use_tls:false});
  if(String(url).endsWith('s2a_ops_mail_claim')){assert.deepEqual(JSON.parse(init.body),{p_transport:'smtp'});claims++;return Response.json([job]);}
  assert.ok(String(url).endsWith('s2a_ops_mail_finish'));assert.equal(JSON.parse(init.body).p_error,'smtp_delivery_uncertain');finishes++;return Response.json(true);
 },async(cfg,message)=>{assert.equal(cfg.smtp_host,'localhost');assert.equal(message.id,job.id);assert.equal(message.to,job.recipient);sends++;throw Object.assign(Error('ambiguous'),{code:'smtp_delivery_uncertain'});});
 const response=await handler(new Request('https://gateway/internal/jobs/mail',{method:'POST',headers:{authorization:'Bearer '+config.serviceKey}}));
 assert.deepEqual(await response.json(),{enabled:true,claimed:1,delivered:0});assert.equal(claims,1);assert.equal(finishes,1);assert.equal(sends,1);
});
