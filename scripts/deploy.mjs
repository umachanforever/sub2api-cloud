import {provisionManagement} from './management.mjs';
import {configureJobScheduler} from './job-scheduler.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from './console.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export function mailSecrets(env) {
  const key=env.RESEND_API_KEY?.trim()||'',from=env.SUB2API_MAIL_FROM?.trim()||'';
  if (!!key!==!!from || key && !/^[A-Za-z0-9_-]{1,512}$/.test(key) || from && (from.length>254 || !/^[A-Za-z0-9.!_%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(from))) throw Error('Configure RESEND_API_KEY and SUB2API_MAIL_FROM together');
  return key ? `RESEND_API_KEY=${key}\nSUB2API_MAIL_FROM=${from}\n` : '';
}
export function deploymentConfig(env) {
  if (env.SUPABASE_MODE && env.SUPABASE_MODE !== 'cloud') throw new Error('Local mode: use npm run up -- --local; this command only deploys to the cloud');
  for (const name of ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUB2API_ADMIN_USER_IDS', 'GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64']) {
    if (!env[name]?.trim()) throw new Error(`Configure ${name} in .env.local first`);
  }
  if (env.SUB2API_DATA_MODEL && env.SUB2API_DATA_MODEL !== 'native') throw new Error('SUB2API_DATA_MODEL must be native or unset');
  const project = validateConfig({ supabase_url: env.SUPABASE_URL, publishable_key: env.SUPABASE_PUBLISHABLE_KEY });
  let role;
  try { role = JSON.parse(Buffer.from(env.SUPABASE_SERVICE_ROLE_KEY.split('.')[1], 'base64url')).role; } catch { /* Invalid JWT. */ }
  if (role !== 'service_role') throw new Error('SUPABASE_SERVICE_ROLE_KEY must be a legacy service_role JWT');
  const ids = env.SUB2API_ADMIN_USER_IDS.split(',').map(id => id.trim().toLowerCase());
  if (ids.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) throw new Error('SUB2API_ADMIN_USER_IDS must contain Auth user UUIDs');
  const key = env.GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64.trim();
  if (Buffer.from(key, 'base64').length !== 32 || Buffer.from(key, 'base64').toString('base64') !== key) throw new Error('The credential encryption key must be 32 bytes encoded as Base64');
  return {
    ref: new URL(project.supabase_url).hostname.split('.')[0],
    secrets: `GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64=${key}\nSUB2API_ADMIN_USER_IDS=${ids.join(',')}\n`+mailSecrets(env)+(env.SUB2API_DATA_MODEL === 'native' ? 'SUB2API_DATA_MODEL=native\n' : ''),
  };
}

export async function deploy(env = process.env, run = (args) => {
  const result = spawnSync('supabase', args, { cwd: root, env, stdio: 'inherit', shell: false });
  if (result.error || result.status !== 0) throw new Error(`Supabase ${args[0]} failed; deployment stopped`);
}, configure = configureJobScheduler, provision = provisionManagement) {
  const config = deploymentConfig(env);
  const directory = await mkdtemp(join(tmpdir(), 'sub2api-deploy-'));
  try {
    const secretsFile = join(directory, 'secrets.env');
    await writeFile(secretsFile, config.secrets, { mode: 0o600 });
    await run(['link', '--project-ref', config.ref]);
    await run(['db', 'push', '--yes']);
    if (env.SUB2API_DATA_MODEL === 'native') await provision(env);
    await run(['secrets', 'set', '--env-file', secretsFile, '--project-ref', config.ref]);
    await run(['functions', 'deploy', 'subscription-api', '--project-ref', config.ref, '--use-api']);
    await configure(env);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try { await deploy(); console.log('Supabase backend deployed. Run npm run frontend to start the local frontend.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
