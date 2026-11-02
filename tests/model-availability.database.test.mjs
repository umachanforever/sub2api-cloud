import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
const exec=promisify(execFile);

test('durable model verification enforces leases, concurrent claims, scope isolation and private grants', {skip:process.env.S2A_DATABASE_TEST!=='1',timeout:60000},async()=>{
 const container='s2a-models-test-'+crypto.randomUUID();
 const sql=input=>new Promise((resolve,reject)=>{
  const child=spawn('docker',['exec','-e','PGPASSWORD=fixture-only','-i',container,'psql','-h','127.0.0.1','-U','postgres','-v','ON_ERROR_STOP=1','-At']);
  let output='',error='';child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>error+=value);
  child.on('error',reject);child.on('close',code=>code===0?resolve(output.trim()):reject(Error(error)));child.stdin.end(input);
 });
 try{
  await exec('docker',['run','--rm','-d','--name',container,'-e','POSTGRES_PASSWORD=fixture-only','postgres:17-alpine']);
  let ready=false;
  for(let attempt=0;attempt<100;attempt++){try{await sql('select 1');ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
  assert.ok(ready);
  await sql('create role s2a_management; create role anon; create role authenticated; create role service_role; create schema s2a_private authorization s2a_management; grant usage on schema s2a_private to service_role;');
  for(let twice=0;twice<2;twice++){
   await sql(await readFile(new URL('../deploy/model-availability.sql',import.meta.url),'utf8'));
   await sql(await readFile(new URL('../deploy/model-availability-scheduler.sql',import.meta.url),'utf8'));
  }
  assert.equal(await sql("select has_table_privilege('service_role','s2a_private.model_availability','SELECT'),has_function_privilege('anon','public.s2a_model_availability_claim()','EXECUTE'),has_function_privilege('service_role','public.s2a_model_availability_claim()','EXECUTE');"),'f|f|t');
  await assert.rejects(sql('set role service_role;select * from s2a_private.model_availability;'),/permission denied/);
  const register=(key='a',fingerprint='b',model='gemini-good')=>`select public.s2a_model_availability_read(repeat('${key}',64),true,null,'192.0.2.1',jsonb_build_array(jsonb_build_object('fingerprint',repeat('${fingerprint}',64),'model','${model}')));`;
  assert.equal(JSON.parse(await sql(register()))[0].verdict,'unverified');
  assert.deepEqual(JSON.parse(await sql(register('c'))),[]);
  const claims=await Promise.all([sql('select public.s2a_model_availability_claim();'),sql('select public.s2a_model_availability_claim();')]);
  const jobs=claims.flatMap(JSON.parse);assert.equal(jobs.length,1);
  const job=jobs[0];assert.equal(job.key_hash,'a'.repeat(64));assert.equal(job.client_ip,'192.0.2.1');
  assert.equal(await sql(`select public.s2a_model_availability_finish('${job.fingerprint}',gen_random_uuid(),'verified');`),'f');
  assert.equal(await sql(`select public.s2a_model_availability_finish('${job.fingerprint}','${job.lease_id}','verified');`),'t');
  assert.equal(JSON.parse(await sql(register()))[0].verdict,'verified');
  assert.equal(await sql("select due_at-checked_at=interval '24 hours' from s2a_private.model_availability;"),'t');
  await sql("update s2a_private.model_availability set due_at=checked_at+interval '5 minutes';");
  await sql(await readFile(new URL('../deploy/model-availability.sql',import.meta.url),'utf8'));
  assert.equal(await sql("select due_at-checked_at=interval '24 hours' from s2a_private.model_availability;"),'t');
  assert.deepEqual(JSON.parse(await sql('select public.s2a_model_availability_claim();')),[]);
  await sql("update s2a_private.model_availability set due_at=clock_timestamp()-interval '1 second';");
  const retry=JSON.parse(await sql('select public.s2a_model_availability_claim();'))[0];
  assert.equal(await sql(`select public.s2a_model_availability_finish('${job.fingerprint}','${job.lease_id}','unsupported');`),'f');
  await sql("update s2a_private.model_availability set lease_until=clock_timestamp()-interval '1 second';");
  assert.equal(await sql(`select public.s2a_model_availability_finish('${retry.fingerprint}','${retry.lease_id}','verified');`),'f');
  assert.equal(JSON.parse(await sql('select public.s2a_model_availability_claim();')).length,1);

  await sql(register('a','d','gemini-3.8-flash-high'));
  await sql(register('c','f','gemini-3.8-flash-high'));
  await sql(register('a','e','gemini-3.8-flash'));
  assert.equal(await sql("select count(*) from s2a_private.model_availability where key_hash=repeat('a',64) and model='gemini-3.8-flash-high';"),'0');
  assert.equal(await sql("select count(*) from s2a_private.model_availability where key_hash=repeat('c',64) and model='gemini-3.8-flash-high';"),'1');
  for(const [fingerprint,verdict] of [['1','temporary'],['2','unsupported']]){
   const model='gemini-daily-'+verdict;
   await sql(register('a',fingerprint,model));
   const daily=JSON.parse(await sql('select public.s2a_model_availability_claim();')).find(job=>job.model===model);
   assert.ok(daily);
   assert.equal(await sql(`select public.s2a_model_availability_finish('${daily.fingerprint}','${daily.lease_id}','${verdict}');`),'t');
   assert.equal(await sql(`select due_at-checked_at=interval '24 hours' from s2a_private.model_availability where fingerprint='${daily.fingerprint}';`),'t');
  }
  assert.equal(await sql("select public.s2a_model_availability_scheduler_configure(null,null,false)->>'enabled';"),'false');
  await assert.rejects(sql(register('a','d','gemini-*')),/invalid_model_verification_jobs/);
 }finally{await exec('docker',['rm','-f',container]).catch(()=>{});}
});
