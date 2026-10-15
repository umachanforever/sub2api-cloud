import assert from 'node:assert/strict';
import test from 'node:test';
import {smtpCaptureServer} from './smtp-server.mjs';
import nodemailer from 'nodemailer';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {Database} from '../supabase/functions/sub2api/db.ts';
import {encryptCredentials,decryptSecret} from '../supabase/functions/sub2api/credential_store.ts';
import {smtpDefaults,smtpField} from '../supabase/functions/sub2api/smtp.ts';
import {smtpOptions,smtpTransport} from '../supabase/functions/sub2api/smtp_transport.mjs';
import {runMailJobs} from '../supabase/functions/sub2api/ops_mail.ts';
const config={url:'https://db',serviceKey:'fixture-key',encryptionKey:Buffer.alloc(32,5).toString('base64'),adminIds:[]};
const req=(path,body,method='POST')=>new Request('https://gateway'+path,{method,headers:{'x-s2a-frontend':'1'},...(body?{body:JSON.stringify(body)}:{})});
test('SMTP protects remote authentication and certificate checks, and supports TLS greeting fallback',async()=>{
 const cfg={...smtpDefaults,smtp_host:'smtp.example.com',smtp_username:'fixture',smtp_password:'fixture-password'};
 assert.equal(smtpOptions({...cfg,smtp_use_tls:false}).requireTLS,true);assert.equal(smtpOptions({...cfg,smtp_host:'localhost',smtp_use_tls:false}).requireTLS,false);
 assert.equal(smtpOptions(cfg).tls.rejectUnauthorized,true);
 const modes=[];let closes=0;
 await smtpTransport(cfg,undefined,opts=>{modes.push(opts);return {verify:async()=>{if(opts.secure)throw Object.assign(Error('greeting'),{reason:'wrong version number'});},close(){closes++;}};});
 assert.deepEqual(modes.map(m=>m.secure),[true,false]);assert.equal(modes[1].requireTLS,true);assert.equal(closes,2);
 let attempts=0;
 await assert.rejects(smtpTransport(cfg,undefined,()=>({verify:async()=>{attempts++;throw Object.assign(Error('certificate'),{code:'CERT_HAS_EXPIRED'});},close(){}})),/certificate/);assert.equal(attempts,1);
 const message={id:'fixture-delivery',to:'fixture@example.com',subject:'Fixture',text:'Fixture'};
 await assert.rejects(smtpTransport(cfg,message,()=>({sendMail:async()=>{throw Error('socket lost');},close(){}})),error=>error.code==='smtp_delivery_uncertain');
});
test('ambiguous SMTP submissions use a terminal completion code without exposing provider errors',async()=>{
 let finish;
 const db=new Database(config,async(url,init)=>String(url).endsWith('s2a_ops_mail_claim')?Response.json([{id:'fixture',lease_id:'lease',recipient:'fixture@example.com',payload:[]}]):(finish=JSON.parse(init.body),Response.json(true)));
 assert.equal((await runMailJobs(db,async()=>{throw Object.assign(Error('password'),{code:'smtp_delivery_uncertain'});})).delivered,0);
 assert.equal(finish.p_error,'smtp_delivery_uncertain');
});
test('real SMTP transport verifies and submits only to a local capture server',async()=>{
 const server=await smtpCaptureServer(),messages=server.messages;
 try {
  const cfg={...smtpDefaults,smtp_host:'127.0.0.1',smtp_port:server.port,smtp_use_tls:false,smtp_password:'',smtp_from_email:'ops@example.com'};
  await smtpTransport(cfg);assert.equal(messages.length,0);
  await smtpTransport(cfg,{id:'fixture-delivery',to:'fixture@example.com',subject:'Fixture',text:'Local capture only'});
  assert.equal(messages.length,1);assert.match(messages[0],/Message-ID: <fixture-delivery@sub2api-supabase.local>/i);assert.match(messages[0],/Local capture only/);
 } finally {await server.close();}
});

test('real SMTP transport negotiates implicit TLS and STARTTLS on custom ports with certificate verification',async()=>{
 const dir=await mkdtemp(tmpdir()+'/s2a-smtp-tls-');
 try {
  await writeFile(dir+'/openssl.cnf','[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:TRUE\n');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',dir+'/openssl.cnf','-keyout',dir+'/key.pem','-out',dir+'/cert.pem'],{stdio:'ignore'});
  const cert=await readFile(dir+'/cert.pem'),key=await readFile(dir+'/key.pem');
  for(const implicit of [true,false]) {
   const server=await smtpCaptureServer({key,cert},implicit);
   try {
    const cfg={...smtpDefaults,smtp_host:'127.0.0.1',smtp_port:server.port,smtp_use_tls:true,smtp_password:'',smtp_from_email:'ops@example.com'};
    const trusted=opts=>nodemailer.createTransport({...opts,tls:{...opts.tls,ca:cert}});
    await smtpTransport(cfg,undefined,trusted);assert.equal(server.messages.length,0);
    await smtpTransport(cfg,{id:'tls-fixture',to:'fixture@example.com',subject:'Fixture',text:'Local TLS capture'},trusted);
    assert.equal(server.messages.length,1);
   } finally {await server.close();}
  }
 } finally {await rm(dir,{recursive:true,force:true});}
});
