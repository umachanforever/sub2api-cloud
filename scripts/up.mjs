import { resolveProjectCredentials } from "./project-credentials.mjs";
import {provisionManagement} from './management.mjs';
import {configureJobScheduler} from './job-scheduler.mjs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateConfig } from './console.mjs';
import { deploy, mailSecrets, oauthSecrets } from './deploy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export function deploymentMode(env, args) {
  const mode = args.includes('--local') ? 'local' : args.includes('--cloud') ? 'cloud' : env.SUPABASE_MODE ?? 'cloud';
  if (!['cloud', 'local'].includes(mode) || args.some(arg => !['--local', '--cloud', '--down'].includes(arg)) || args.includes('--local') && args.includes('--cloud')) throw Error('Use --local or --cloud');
  return mode;
}
export function localProject(status) {
  const config = validateConfig({ mode: 'local', supabase_url: status.API_URL, publishable_key: status.ANON_KEY ?? status.PUBLISHABLE_KEY });
  if (!status.SERVICE_ROLE_KEY) throw Error('Local Supabase SERVICE_ROLE_KEY unavailable');
  const containerURL = new URL(config.supabase_url);
  containerURL.hostname = 'host.docker.internal';
  return { SUPABASE_MODE: 'local', SUPABASE_URL: config.supabase_url, SUPABASE_PUBLISHABLE_KEY: config.publishable_key,
    SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY, containerURL: containerURL.origin };
}
async function run(command, args, env, capture = false) {
  const child = spawn(command, args, { cwd: root, env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: false });
  let output = '';
  if (capture) { child.stdout.on('data', chunk => { output += chunk; }); child.stderr.resume(); }
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error(`${command} ${args[0]} failed`))); });
  return output;
}
export async function administrator(env, fetchImpl = fetch) {
  const email = env.SUB2API_LOCAL_ADMIN_EMAIL || 'admin@sub2api.local';
  const password = env.SUB2API_LOCAL_ADMIN_PASSWORD;
  if (!password) throw Error('Administrator password required');
  const headers = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/json' };
  const login = await fetchImpl(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(20_000),
  });
  if (login.ok) {
    const session = await login.json();
    if (typeof session.user?.id !== 'string') throw Error('Invalid administrator session');
    return session.user.id;
  }
  await login.body?.cancel();
  if (login.status !== 400) throw Error('Administrator login unavailable');
  const authorization = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/s2a_registration_authorize`, {
    method: 'POST', headers, body: JSON.stringify({p_email: email}), signal: AbortSignal.timeout(20_000),
  });
  let ticket;
  if (authorization.ok) {
    ticket = (await authorization.json()).token;
    if (typeof ticket !== 'string' || !/^[0-9a-f]{64}$/.test(ticket)) throw Error('Invalid administrator authorization');
  } else {
    const failure = await authorization.json();
    if (authorization.status !== 404 || failure.code !== 'PGRST202') throw Error('Administrator authorization unavailable');
  }
  const created = await fetchImpl(`${env.SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST', headers, body: JSON.stringify({ email, password, email_confirm: true, app_metadata: {s2a_managed_user: true}, ...(ticket ? {user_metadata: {s2a_registration_ticket: ticket}} : {}) }), signal: AbortSignal.timeout(20_000),
  });
  if (!created.ok) { await created.body?.cancel(); throw Error('Cannot create administrator; check credentials or use the existing account password'); }
  const user = await created.json();
  if (typeof user.id !== 'string') throw Error('Invalid administrator response');
  return user.id;
}
async function up() {
  const args = process.argv.slice(2), mode = deploymentMode(process.env, args);
  let env = { ...process.env, SUPABASE_MODE: mode, SUB2API_DATA_MODEL: process.env.SUB2API_DATA_MODEL || 'native' };
  if (args.includes('--down')) {
    await run('docker', ['compose', '-p', 'sub2api-supabase', 'down'], { ...env, SUPABASE_URL: env.SUPABASE_URL || 'http://host.docker.internal:54321', SUPABASE_PUBLISHABLE_KEY: env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_local_shutdown_placeholder' });
    if (mode === 'local') await run('supabase', ['stop'], env);
    return;
  }
  await mkdir(new URL('../.local/', import.meta.url), { recursive: true, mode: 0o700 });
  if (mode === 'local') {
    // Build before starting the full local stack to reduce peak Docker memory use.
    await run('docker', ['compose', '-p', 'sub2api-supabase', 'build'], { ...env, SUPABASE_URL: 'http://host.docker.internal:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_build_placeholder' });
    console.log('Starting local Supabase (first run downloads Docker images)...');
    await run('supabase', ['start'], env, true);
    await run('supabase', ['migration', 'up', '--local'], env);
    env = { ...env, GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64: undefined, ...localProject(JSON.parse(await run('supabase', ['status', '-o', 'json'], env, true))) };
    try { const stored = JSON.parse(await readFile(new URL('../.local/admin.json', import.meta.url), 'utf8')); if (typeof stored.SUB2API_LOCAL_ADMIN_PASSWORD !== 'string' || !stored.SUB2API_LOCAL_ADMIN_PASSWORD || typeof stored.GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64 !== 'string' || Buffer.from(stored.GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64, 'base64').length !== 32) throw Error('Invalid .local/admin.json; restore the original encryption key instead of regenerating it'); env.SUB2API_LOCAL_ADMIN_EMAIL = stored.SUB2API_LOCAL_ADMIN_EMAIL; env.SUB2API_LOCAL_ADMIN_PASSWORD = stored.SUB2API_LOCAL_ADMIN_PASSWORD; env.GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64 = stored.GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } else {
    validateConfig({ supabase_url: env.SUPABASE_URL, publishable_key: env.SUPABASE_PUBLISHABLE_KEY });
    env = await resolveProjectCredentials(env);
  }
  const additions = {};
  if (!env.GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64 || env.GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64.startsWith('REPLACE_')) additions.GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64 = randomBytes(32).toString('base64');
  if (!env.SUB2API_LOCAL_ADMIN_PASSWORD) additions.SUB2API_LOCAL_ADMIN_PASSWORD = randomBytes(24).toString('base64url');
  env = { ...env, ...additions };
  if (mode === 'cloud' && Object.keys(additions).length) await appendFile(new URL('../.env.local', import.meta.url), '\n' + Object.entries(additions).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 });
  if (mode === 'local') await writeFile(new URL('../.local/admin.json', import.meta.url), JSON.stringify({ SUB2API_LOCAL_ADMIN_EMAIL: env.SUB2API_LOCAL_ADMIN_EMAIL || 'admin@sub2api.local', SUB2API_LOCAL_ADMIN_PASSWORD: env.SUB2API_LOCAL_ADMIN_PASSWORD, GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64: env.GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64 }), { mode: 0o600 });
  if (mode === 'local' || !env.SUB2API_ADMIN_USER_IDS || env.SUB2API_ADMIN_USER_IDS.startsWith('YOUR_')) {
    env.SUB2API_ADMIN_USER_IDS = await administrator(env);
    if (mode === 'cloud') await appendFile(new URL('../.env.local', import.meta.url), `\nSUB2API_ADMIN_USER_IDS=${env.SUB2API_ADMIN_USER_IDS}\n`, { mode: 0o600 });
  }
  if (mode === 'cloud') { await chmod(new URL('../.env.local', import.meta.url), 0o600); await deploy(env); }
  if (mode === 'local') await provisionManagement(env);
  await run('docker', ['compose', '-p', 'sub2api-supabase', 'up', '-d', ...(mode === 'cloud' ? ['--build'] : [])], { ...env, SUPABASE_URL: env.containerURL ?? env.SUPABASE_URL });
  if (mode === 'local') {
    const file = new URL('../.local/functions.env', import.meta.url);
    await writeFile(file, `GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64=${env.GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64}\nSUB2API_ADMIN_USER_IDS=${env.SUB2API_ADMIN_USER_IDS}\nSUB2API_DATA_MODEL=native\n`+mailSecrets(env)+oauthSecrets(env), { mode: 0o600 });
    console.log('Local Supabase mode. Keep this terminal running; stop with npm run down -- --local. Administrator credentials: .local/admin.json');
    // Docker Desktop can share the project while macOS's system temp directory is unavailable.
    const temp = fileURLToPath(new URL('../.local/tmp/', import.meta.url));
    await mkdir(temp, { recursive: true, mode: 0o700 });
    await configureJobScheduler(env,'http://kong:8000');
    const worker = spawn('supabase', ['functions', 'serve', '--env-file', fileURLToPath(file)], { cwd: root, env: { ...env, TMPDIR: temp, TMP: temp, TEMP: temp }, stdio: 'inherit', shell: false });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => worker.kill(signal));
    await new Promise((resolve, reject) => { worker.on('error', reject); worker.on('exit', (code, signal) => code === 0 || signal ? resolve() : reject(Error('Local Edge runtime stopped'))); });
  } else console.log('sub2api-supabase deployed: http://127.0.0.1:' + (env.CONSOLE_PORT || '3000'));
}
if (import.meta.main) up().catch(error => { console.error(error.message); process.exitCode = 1; });
