import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function issueAgentAccess(env = process.env) {
  for (const name of ['SUPABASE_URL', 'SUB2API_LOCAL_ADMIN_EMAIL', 'SUB2API_LOCAL_ADMIN_PASSWORD', 'GPT_SUBSCRIPTION_GATEWAY_KEY']) {
    if (!env[name]) throw Error(`Configure ${name} before issuing agent access`);
  }
  const directory = new URL('../.local/', import.meta.url);
  let previous;
  try { previous = JSON.parse(await readFile(new URL('agent-usage.json', directory), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous?.scope === 'usage:read' && !env.SUPABASE_ACCESS_TOKEN) throw Error('SUPABASE_ACCESS_TOKEN is required to revoke the previous usage-only token');
  const management = 'http://127.0.0.1:' + (env.CONSOLE_PORT || '3000') + '/api/v1';
  let authorization;
  async function api(path, method = 'GET', body) {
    const response = await fetch(management + path, {
      method,
      headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    if (!response.ok || result.code !== 0) throw Error(`Agent key management request failed (${response.status})`);
    return result.data;
  }
  const session = await api('/auth/login', 'POST', { email: env.SUB2API_LOCAL_ADMIN_EMAIL, password: env.SUB2API_LOCAL_ADMIN_PASSWORD });
  if (!session.access_token) throw Error('Management session is unavailable');
  authorization = 'Bearer ' + session.access_token;
  let source;
  for (let page = 1; page <= 100; page++) {
    const keys = await api(`/keys?page=${page}&page_size=100`);
    source = keys.items?.find(key => key.key === env.GPT_SUBSCRIPTION_GATEWAY_KEY && key.status === 'active');
    if (source || !keys.items?.length || keys.items.length < 100) break;
  }
  if (!source?.group_id) throw Error('The configured inference key must belong to the current administrator and have a provider group');
  const created = await api('/keys', 'POST', { name: 'Agent API access', group_id: source.group_id });
  if (typeof created.key !== 'string' || !created.key.startsWith('sk-')) throw Error('The API key prefix must be configured as sk-');
  const baseURL = env.SUPABASE_URL.replace(/\/$/, '') + '/functions/v1/subscription-api/v1';
  const config = { base_url: baseURL, api_key: created.key, model: 'gpt-6.1-sol', usage_url: baseURL + '/usage', refresh_url: baseURL + '/usage?refresh=true', authentication: 'Authorization: Bearer <api_key>', scope: 'api:full' };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of ['agent-access.json']) {
    const path = new URL(name, directory);
    await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    await chmod(path, 0o600);
  }
  if (previous?.scope === 'usage:read') {
    const digest = createHash('sha256').update(previous.api_key).digest('hex');
    const project = new URL(env.SUPABASE_URL).hostname;
    if (!/^[a-z0-9]+\.supabase\.co$/.test(project)) throw Error('Cloud Supabase is required to revoke the previous usage token');
    const response = await fetch(`https://api.supabase.com/v1/projects/${project.split('.')[0]}/database/query`, {
      method: 'POST', headers: { authorization: 'Bearer ' + env.SUPABASE_ACCESS_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ query: `UPDATE s2a_private.usage_tokens SET revoked_at=coalesce(revoked_at,now()) WHERE token_hash='${digest}' RETURNING token_hash;` }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw Error(`Previous usage token revocation failed (${response.status})`); }
    await response.body?.cancel();
    console.log('Previous usage-only token revoked.');
  }
  const compatiblePath = new URL('agent-usage.json', directory);
  await writeFile(compatiblePath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await chmod(compatiblePath, 0o600);
  console.log(`Full API configuration saved: ${fileURLToPath(new URL('agent-access.json', directory))}`);
}

if (import.meta.main) {
  try { await issueAgentAccess(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
