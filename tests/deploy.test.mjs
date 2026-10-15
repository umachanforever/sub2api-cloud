import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { deploy, deploymentConfig } from '../scripts/deploy.mjs';
const service = `header.${Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url')}.signature`;
const env = {SUPABASE_URL:'https://project.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_12345678901234567890',SUPABASE_SERVICE_ROLE_KEY:service,SUB2API_ADMIN_USER_IDS:'11111111-1111-4111-8111-111111111111',GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64:Buffer.alloc(32,7).toString('base64')};

test('deployment refuses missing config and never sends local credentials as cloud secrets',async()=>{
  assert.throws(()=>deploymentConfig({...env,SUPABASE_MODE:'local'}),/Local mode/);
  assert.throws(()=>deploymentConfig({...env,SUPABASE_URL:''}),/SUPABASE_URL/);
  assert.throws(()=>deploymentConfig({...env,SUPABASE_SERVICE_ROLE_KEY:'anon'}),/service_role/);
  assert.throws(()=>deploymentConfig({...env,SUPABASE_URL:'https://evil.invalid'}));
  const calls=[];let path;
  await deploy(env,async args=>{
    calls.push(args);
    if(args[0]==='secrets'){
      path=args[args.indexOf('--env-file')+1];
      const content=await readFile(path,'utf8');
      assert.match(content,/GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64=/);
      assert.match(content,/SUB2API_ADMIN_USER_IDS=/);
      assert.doesNotMatch(content,/SUPABASE_SERVICE_ROLE_KEY|SUPABASE_ACCESS_TOKEN|SUPABASE_DB_PASSWORD/);
      assert.equal((await stat(path)).mode & 0o777,0o600);
    }
  },async config=>{assert.equal(config,env);calls.push(['scheduler']);});
  assert.deepEqual(calls.map(args=>args[0]),['link','db','secrets','functions','scheduler']);
  assert.equal(calls[0][2],'project');
  assert.ok(calls[1].includes('--yes'));
  assert.ok(calls[3].includes('--use-api'));
  await assert.rejects(stat(path),{code:'ENOENT'});
});

test('a failed migration stops deployment and cleans the temporary directory',async()=>{
  const calls=[];
  await assert.rejects(deploy(env,async args=>{calls.push(args[0]);if(args[0]==='db')throw new Error('migration_failed');},undefined),/migration_failed/);
  assert.deepEqual(calls,['link','db']);
});

test('scheduler failure after function deployment still cleans private temporary files',async()=>{
 let path;const calls=[];
 await assert.rejects(deploy(env,async args=>{calls.push(args[0]);if(args[0]==='secrets')path=args[args.indexOf('--env-file')+1];},async()=>{throw Error('scheduler_failed');}),/scheduler_failed/);
 assert.deepEqual(calls,['link','db','secrets','functions']);await assert.rejects(stat(path),{code:'ENOENT'});
});

 test('native deployment selects the canonical gateway without leaking database access',()=>{
 const config=deploymentConfig({...env,SUB2API_DATA_MODEL:'native',DATABASE_URL:'private'});
 assert.match(config.secrets,/SUB2API_DATA_MODEL=native\n/);
 assert.doesNotMatch(config.secrets,/DATABASE_URL|private/);
 assert.throws(()=>deploymentConfig({...env,SUB2API_DATA_MODEL:'invalid'}),/SUB2API_DATA_MODEL/);
 });

test('native deployment provisions management before switching cloud secrets',async()=>{
 const calls=[];const config={...env,SUB2API_DATA_MODEL:'native'};
 await deploy(config,async args=>{calls.push(args[0]);},async()=>{calls.push('scheduler');},async value=>{assert.equal(value,config);calls.push('management');});
 assert.deepEqual(calls,['link','db','management','secrets','functions','scheduler']);
});
