import { Database, HttpError } from './db.ts';
import { hashKey } from './validation.ts';
import { json } from './http.ts';
import { authorizeJob } from './privacy_jobs.ts';
import { proxyScheduledModelProbe } from './proxy.ts';
import { ModelAvailability } from './model_availability.ts';
import type { Platform } from './gateway.ts';

type Entry = Record<string, any>;
type Verdict = 'verified' | 'temporary' | 'unsupported' | 'unverified';
type Status = { fingerprint: string; verdict: Verdict; checked_at: string | null };
type Job = { fingerprint: string; lease_id: string; key_hash: string; native: boolean; platform: Platform | null; client_ip: string | null; model: string };
const modelId = (entry: Entry) => String(entry?.id ?? entry?.name ?? entry?.slug ?? '').replace(/^models\//, '');
const needsProbe = (entry: Entry, native: boolean) => native || modelId(entry).startsWith('gemini-') || ['google', 'gemini', 'antigravity'].includes(entry?.owned_by);
const digest = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))), byte => byte.toString(16).padStart(2, '0')).join('');

// Public listings only enqueue work and read durable verdicts; inference belongs
// exclusively to the signed worker. No client or provider credential is stored.
export async function scheduledModelFilter(response: Response, request: Request, token: string, db: Database, native: boolean, platform?: Platform): Promise<Response> {
  if (!response.ok || response.status === 204) return response;
  const body = await response.clone().json().catch(() => null);
  const field = Array.isArray(body?.data) ? 'data' : Array.isArray(body?.models) ? 'models' : undefined;
  if (!field) return response;
  const entries = body[field] as Entry[];
  const candidates = entries.filter(entry => needsProbe(entry, native));
  if (!candidates.length) return response;
  const keyHash = await hashKey(token);
  const clientIp = request.headers.get('cf-connecting-ip')?.trim() || request.headers.get('x-real-ip')?.trim() || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
  const scope = await digest([keyHash, native, platform ?? null]);
  const jobs = await Promise.all(candidates.map(async entry => ({ entry, model: modelId(entry), fingerprint: await digest([scope, entry]) })));
  const valid = jobs.filter(job => /^[a-zA-Z0-9._-]{1,200}$/.test(job.model));
  const statuses = valid.length ? await db.rpc<Status[]>('s2a_model_availability_read', {
    p_key_hash: keyHash, p_native: native, p_platform: platform ?? null, p_client_ip: clientIp,
    p_jobs: [...new Map(valid.map(({ fingerprint, model }) => [fingerprint, { fingerprint, model }])).values()],
  }) : [];
  if (!Array.isArray(statuses)) throw new HttpError(503, 'model_verification_unavailable');
  const byId = new Map(statuses.map(status => [status.fingerprint, status]));
  const available = new Set<Entry>();
  const counts = { verified: 0, temporary: 0, unsupported: 0, unverified: 0 };
  for (const job of jobs) {
    const status = byId.get(job.fingerprint);
    // A stopped scheduler must not advertise indefinitely stale successes.
    const fresh = status?.checked_at && Date.now() - Date.parse(status.checked_at) < 30 * 60_000;
    const verdict = fresh && status && status.verdict in counts ? status.verdict : 'unverified';
    counts[verdict]++;
    if (verdict === 'verified') available.add(job.entry);
  }
  await response.body?.cancel();
  const headers = new Headers(response.headers);
  for (const name of ['content-length', 'content-encoding', 'etag', 'last-modified']) headers.delete(name);
  headers.set('cache-control', 'no-store');
  headers.set('content-type', 'application/json');
  headers.set('x-s2a-model-verification', Object.entries(counts).map(([name, count]) => `${name}=${count}`).join('; '));
  return new Response(JSON.stringify({ ...body, [field]: entries.filter(entry => !needsProbe(entry, native) || available.has(entry)) }), { status: response.status, headers });
}

export async function modelAvailabilityJobs(request: Request, db: Database): Promise<Response> {
  await authorizeJob(request, db, 'models');
  const jobs = await db.rpc<Job[]>('s2a_model_availability_claim', {});
  let next = 0, finished = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      let verdict: Verdict = 'temporary';
      try {
        const headers = new Headers({ 'content-type': 'application/json' });
        if (job.client_ip) headers.set('x-real-ip', job.client_ip);
        const probeRequest = new Request(new URL('/v1/models', request.url), { headers });
        const result = await new ModelAvailability(Date.now, { listing: 17_000, probe: 15_000 }).filter(
          Response.json({ data: [{ id: job.model, owned_by: 'gemini' }] }), probeRequest, job.fingerprint, job.native,
          (req, path) => proxyScheduledModelProbe(req, path, job.key_hash, db, { requestId: crypto.randomUUID(), started: Date.now(), endpoint: path }, job.platform ?? undefined),
        );
        const counts = result.headers.get('x-s2a-model-verification') ?? '';
        verdict = /(?:^|; )verified=1(?:;|$)/.test(counts) ? 'verified' : /unsupported=1/.test(counts) ? 'unsupported' : 'temporary';
        await result.body?.cancel();
      } catch { /* A failed probe is retried by the next scheduled batch. */ }
      if (await db.rpc<boolean>('s2a_model_availability_finish', { p_fingerprint: job.fingerprint, p_lease_id: job.lease_id, p_verdict: verdict })) finished++;
    }
  }));
  return json(200, { claimed: jobs.length, finished });
}
