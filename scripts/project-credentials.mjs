// Hosted Edge Functions receive this key from Supabase. Local provisioning can
// retrieve the existing project key through the authenticated Management API.
export async function resolveProjectCredentials(env, fetchImpl = fetch) {
  if (env.SUPABASE_SERVICE_ROLE_KEY?.trim()) return env;
  if (!env.SUPABASE_ACCESS_TOKEN?.trim()) throw Error('Set SUPABASE_ACCESS_TOKEN to retrieve the project service-role key automatically, or provide SUPABASE_SERVICE_ROLE_KEY');
  let url;
  try { url = new URL(env.SUPABASE_URL); } catch { throw Error('Configure a hosted SUPABASE_URL before retrieving project credentials'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9]+\.supabase\.co$/.test(url.hostname) || url.username || url.password || url.port || url.search || url.hash || !['', '/'].includes(url.pathname)) throw Error('Automatic project credentials require a hosted Supabase project URL');
  const ref = url.hostname.split('.')[0];
  let response;
  try {
    response = await fetchImpl(`https://api.supabase.com/v1/projects/${ref}/api-keys`, {
      headers: { authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN.trim()}` },
      signal: AbortSignal.timeout(20000), redirect: 'error',
    });
  } catch { throw Error('Cannot retrieve Supabase project credentials; check Management API access'); }
  if (!response.ok) { await response.body?.cancel(); throw Error(`Cannot retrieve Supabase project credentials (${response.status}); check the access token and project permissions`); }
  let keys;
  try { keys = await response.json(); } catch { throw Error('Invalid Supabase project credentials response'); }
  const key = Array.isArray(keys) ? keys.find(item => {
    if (item?.name !== 'service_role' || typeof item.api_key !== 'string') return false;
    try {
      const claims = JSON.parse(Buffer.from(item.api_key.split('.')[1], 'base64url'));
      return claims.role === 'service_role' && (!claims.ref || claims.ref === ref);
    } catch { return false; }
  })?.api_key : undefined;
  if (!key) throw Error('The project did not return a legacy service-role key; provide SUPABASE_SERVICE_ROLE_KEY explicitly');
  return { ...env, SUPABASE_SERVICE_ROLE_KEY: key };
}
