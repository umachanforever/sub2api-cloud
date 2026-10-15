import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Issue a usage-only token without exposing the linked inference key.
export async function issueUsageAccess(env = process.env) {
  for (const name of ['SUPABASE_URL', 'SUPABASE_ACCESS_TOKEN', 'GPT_SUBSCRIPTION_GATEWAY_KEY']) {
    if (!env[name]) throw Error(`Configure ${name} before issuing usage access`);
  }
  const project = new URL(env.SUPABASE_URL);
  if (project.protocol !== 'https:' || !/^[a-z0-9]+\.supabase\.co$/.test(project.hostname)) throw Error('A cloud Supabase project is required');
  const digest = value => createHash('sha256').update(value).digest('hex');
  const token = 'sk-usage-' + randomBytes(32).toString('hex');
  const keyHash = digest(env.GPT_SUBSCRIPTION_GATEWAY_KEY);
  const response = await fetch(`https://api.supabase.com/v1/projects/${project.hostname.split('.')[0]}/database/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: `INSERT INTO s2a_private.usage_tokens(token_hash,api_key_id,name)
      SELECT '${digest(token)}',id,'Agent usage access' FROM public.api_keys
      WHERE s2a_key_hash='${keyHash}' AND deleted_at IS NULL AND status='active'
        AND (expires_at IS NULL OR expires_at>now()) RETURNING api_key_id::text;` }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) { await response.body?.cancel(); throw Error(`Usage access provisioning failed (${response.status})`); }
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length !== 1) throw Error('An active inference key is required');
  const baseURL = project.origin + '/functions/v1/subscription-api/v1';
  const path = new URL('../.local/agent-usage.json', import.meta.url);
  await mkdir(new URL('../.local/', import.meta.url), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ base_url: baseURL, api_key: token, usage_url: baseURL + '/usage', refresh_url: baseURL + '/usage?refresh=true', authentication: 'Authorization: Bearer <api_key>', scope: 'usage:read' }, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
  console.log(`Read-only usage configuration saved: ${fileURLToPath(path)}`);
}

if (import.meta.main) {
  try { await issueUsageAccess(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
