import {requestLimitSecrets} from '../supabase/functions/sub2api/request_limits.ts';
import { resolveProjectCredentials } from "./project-credentials.mjs";
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,chmod} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const privateDir=new URL('../.local/',import.meta.url);
const literal=value=>"'"+String(value).replaceAll("'","''")+"'";

async function command(args,env,input,visible=false){
 const child=spawn('docker',args,{cwd:root,env,stdio:[input===undefined?'ignore':'pipe',visible?'inherit':'pipe',visible?'inherit':'pipe'],shell:false});
 let output='';
 if(!visible){child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);}
 if(input!==undefined)child.stdin.end(input);
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
 if(code!==0){
  await writeFile(new URL('management-setup.log',privateDir),output,{mode:0o600});
  throw Error(`Management ${args[0]} failed; inspect .local/management-setup.log`);
 }
}

export async function provisionManagement(env=process.env){
 env=await resolveProjectCredentials(env);
 const local=env.SUPABASE_MODE==='local';
 if(!env.SUPABASE_URL||!env.SUPABASE_SERVICE_ROLE_KEY||!env.SUPABASE_PUBLISHABLE_KEY||!env.SUB2API_ADMIN_USER_IDS)throw Error('Configure the Supabase project and administrator before provisioning management');
 if(!local&&!env.SUPABASE_ACCESS_TOKEN)throw Error('Set SUPABASE_ACCESS_TOKEN in .env.local to provision the management database');
 await mkdir(privateDir,{recursive:true,mode:0o700});
 const ref=local?'local':new URL(env.SUPABASE_URL).hostname.split('.')[0];
 const configPath=new URL(local?'management-local.json':'management-cloud.json',privateDir);
 let saved;
 try{saved=JSON.parse(await readFile(configPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;saved={};}
 let database;
 if(local){database=new URL('postgres://s2a_management@host.docker.internal:54322/postgres?sslmode=disable');}
 else{
  database=new URL((await readFile(new URL('../supabase/.temp/pooler-url',import.meta.url),'utf8')).trim());
  if(!database.hostname.endsWith('.pooler.supabase.com')||database.port!=='5432')throw Error('Supabase session pooler URL is required for management');
  database.username=`s2a_management.${ref}`;database.search='?sslmode=require';
 }
 if(saved.database_url){
  const previous=new URL(saved.database_url);
  if(previous.hostname!==database.hostname||previous.username!==database.username||previous.port!==database.port)throw Error('Stored management database belongs to a different project; use a separate checkout');
 }
 const password=saved.password||randomBytes(32).toString('hex');
 if(!/^[a-f0-9]{64}$/.test(password))throw Error('Invalid stored management password');
 database.password=password;
 const config={...saved,database_url:database.href,password,jwt:saved.jwt||randomBytes(32).toString('hex'),totp:saved.totp||randomBytes(32).toString('hex'),setup_password:saved.setup_password||randomBytes(32).toString('hex')};
 await writeFile(configPath,JSON.stringify(config),{mode:0o600});await chmod(configPath,0o600);
 async function sql(query){
  if(local){await command(['exec','-i','supabase_db_sub2api-cloud','psql','-X','-q','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],env,query);return;}
  const response=await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`,{method:'POST',headers:{authorization:`Bearer ${env.SUPABASE_ACCESS_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(60000)});
  const body=await response.text();
  if(!response.ok){await writeFile(new URL('management-setup.log',privateDir),body,{mode:0o600});throw Error(`Management schema setup failed (${response.status}); inspect .local/management-setup.log`);}
 }
 await sql(await readFile(new URL('../deploy/management-role.sql',import.meta.url),'utf8'));
 await sql(`DO $provision$ BEGIN
IF EXISTS(SELECT FROM pg_authid WHERE rolname='s2a_management' AND rolpassword IS NULL) THEN
ALTER ROLE s2a_management PASSWORD ${literal(password)};
END IF; END $provision$;`);
 const runtime={AUTO_SETUP:'true',DATABASE_URL:database.href,DATABASE_HOST:database.hostname,DATABASE_PORT:database.port,DATABASE_USER:decodeURIComponent(database.username),DATABASE_PASSWORD:password,DATABASE_DBNAME:'postgres',DATABASE_SSLMODE:local?'disable':'require',SUPABASE_URL:local?'http://host.docker.internal:54321':env.SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY:env.SUPABASE_PUBLISHABLE_KEY,SUPABASE_JWT_ISSUER:env.SUPABASE_URL+'/auth/v1',ADMIN_EMAIL:env.SUB2API_LOCAL_ADMIN_EMAIL||'admin@sub2api.local',ADMIN_PASSWORD:config.setup_password,JWT_SECRET:config.jwt,TOTP_ENCRYPTION_KEY:config.totp};
 for(const key of ['ANTIGRAVITY_OAUTH_CLIENT_ID','ANTIGRAVITY_OAUTH_CLIENT_SECRET','GEMINI_CLI_OAUTH_CLIENT_ID','GEMINI_CLI_OAUTH_CLIENT_SECRET','GEMINI_OAUTH_CLIENT_ID','GEMINI_OAUTH_CLIENT_SECRET'])if(env[key])runtime[key]=env[key];
 for(const value of Object.values(runtime))if(/[\r\n]/.test(value))throw Error('Management runtime configuration must be single-line');
 Object.assign(runtime,Object.fromEntries(requestLimitSecrets(env).trim().split('\n').map(line=>line.split('='))));
 const runtimePath=new URL('management.env',privateDir);
 await writeFile(runtimePath,Object.entries(runtime).map(([key,value])=>`${key}=${value}`).join('\n')+'\n',{mode:0o600});await chmod(runtimePath,0o600);
 const compose=['compose','-p','sub2api-cloud'];
 if(env.S2A_SKIP_MANAGEMENT_BUILD!=='1')await command([...compose,'build','management'],env,undefined,true);
 await command([...compose,'run','--rm','--no-deps','management','-migrate'],env);
 for(const path of ['account-vault.sql','gateway-proxy.sql','composite-routing.sql','pinned-models.sql','personal-gateway.sql','request-lease.sql','image-tasks.sql','batch-image-runtime.sql','artifact-storage.sql','usage-access.sql','codex-scheduler.sql','gemini-cache-scheduler.sql','image-scheduler.sql','batch-image-scheduler.sql','gateway-maintenance.sql'])await sql(await readFile(new URL('../deploy/'+path,import.meta.url),'utf8'));
 for(const id of env.SUB2API_ADMIN_USER_IDS.split(',').map(value=>value.trim())){
  if(!/^[a-f0-9-]{36}$/i.test(id))throw Error('Invalid administrator Auth UUID');
  const response=await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${id}`,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`},signal:AbortSignal.timeout(20000)});
  if(!response.ok){await response.body?.cancel();throw Error('Configured administrator Auth identity is unavailable');}
  const identity=await response.json();
  if(identity.id!==id||typeof identity.email!=='string'||!identity.email_confirmed_at)throw Error('Administrator must have a confirmed Supabase email identity');
  const issuer=env.SUPABASE_URL+'/auth/v1';
  await sql(`BEGIN; SET LOCAL ROLE s2a_management;
INSERT INTO public.users(email,password_hash,role,balance,concurrency,status,signup_source) VALUES(${literal(identity.email)},'!supabase-auth-only','admin',0,20,'active','oidc') ON CONFLICT(email) WHERE deleted_at IS NULL DO NOTHING;
INSERT INTO public.auth_identities(user_id,provider_type,provider_key,provider_subject,verified_at,issuer) SELECT id,'oidc',${literal(issuer)},${literal(id)},now(),${literal(issuer)} FROM public.users WHERE email=${literal(identity.email)} AND deleted_at IS NULL ON CONFLICT(provider_type,provider_key,provider_subject) DO NOTHING;
SELECT 1 / count(*)::integer AS administrator_identity_verified FROM public.users u JOIN public.auth_identities a ON a.user_id=u.id WHERE u.email=${literal(identity.email)} AND u.deleted_at IS NULL AND u.role='admin' AND a.provider_type='oidc' AND a.provider_key=${literal(issuer)} AND a.provider_subject=${literal(id)};
COMMIT;`);
 }
 await sql(`BEGIN; SET LOCAL ROLE s2a_management;
INSERT INTO public.settings(key,value) VALUES('api_base_url',${literal(env.SUPABASE_URL+'/functions/v1/sub2api')}) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE btrim(settings.value)='' OR settings.value ~* '^https?://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]+)?(/|$)';
INSERT INTO public.settings(key,value) VALUES('site_name','sub2api-cloud') ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE lower(btrim(settings.value)) IN ('sub2api','sub2api-supabase');
COMMIT;`);
 console.log('Management schema, encrypted credentials, and cloud identity are ready.');
}

if(import.meta.main){try{await provisionManagement();}catch(error){console.error(error.message);process.exitCode=1;}}
