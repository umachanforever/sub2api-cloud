import { Database, HttpError } from './db.ts';
import { json } from './http.ts';
import { queryOpenAIQuota, type QuotaAccount } from './openai_quota.ts';
import { quotaWindowUpdates } from './openai_quota_values.ts';
import { hashKey } from './validation.ts';
import { cachedProviderWindows, queryProviderUsage, supportsProviderUsage, type UsageWindow } from './provider_usage.ts';

type Snapshot = Record<string, unknown>;
type UsageAccount = QuotaAccount & { name?: string; status?: string; quota_snapshot?: Snapshot; usage_snapshot?: { fetched_at?: number; windows?: unknown } };
const TTL_SECONDS = 60;

function window(snapshot: Snapshot, period: '5h' | '7d', now: number) {
  const used = snapshot[`codex_${period}_used_percent`];
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
  const minutes = snapshot[`codex_${period}_window_minutes`];
  const reset = snapshot[`codex_${period}_reset_at`];
  const resetAt = typeof reset === 'string' && Number.isFinite(Date.parse(reset)) ? reset : null;
  return {
    used_percent: used,
    remaining_percent: Math.max(0, 100 - used),
    window_seconds: typeof minutes === 'number' && Number.isFinite(minutes) ? minutes * 60 : null,
    reset_at: resetAt,
    reset_after_seconds: resetAt === null ? null : Math.max(0, Math.ceil(Date.parse(resetAt) / 1000 - now)),
  };
}

export async function usageAccess(request: Request, token: string, db: Database): Promise<Response> {
  if (db.config.dataModel !== 'native') throw new HttpError(501, 'native_data_model_required');
  const url = new URL(request.url);
  const id = url.searchParams.get('account_id');
  if (id !== null && (!/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n)) throw new HttpError(400, 'invalid_account_id');
  const refresh = url.searchParams.get('refresh');
  if (refresh !== null && !['true', 'false'].includes(refresh)) throw new HttpError(400, 'invalid_refresh');
  const force = refresh === 'true' || /no-cache|no-store/i.test(request.headers.get('cache-control') ?? '');
  const clientIp = request.headers.get('cf-connecting-ip')?.trim() || request.headers.get('x-real-ip')?.trim() || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
  const result = await db.rpc<{ accounts: UsageAccount[]; error?: string; status?: number }>('s2a_personal_usage_accounts', {
    p_key_hash: await hashKey(token), p_client_ip: clientIp, p_account_id: id,
  });
  if (result.error) throw new HttpError(result.status ?? 403, result.error);
  const enabledAccounts = result.accounts.filter(account => account.status === undefined || account.status === 'active');
  // Batch provider reads to bound concurrency for pooled groups.
  const accounts: Record<string, unknown>[] = [];
  for (let offset = 0; offset < enabledAccounts.length; offset += 4) {
    accounts.push(...await Promise.all(enabledAccounts.slice(offset, offset + 4).map(async account => {
      if (account.platform !== 'openai' || account.type !== 'oauth') return providerUsage(request, account, db, force);
      let snapshot = account.quota_snapshot ?? {};
      let fetched = typeof snapshot.codex_usage_updated_at === 'string' ? Date.parse(snapshot.codex_usage_updated_at) / 1000 : NaN;
      const now = Math.floor(Date.now() / 1000);
      let cached = true, error: string | undefined;
      const expiredWindow = ['5h', '7d'].some(period => {
        const reset = snapshot[`codex_${period}_reset_at`];
        return typeof reset === 'string' && Date.parse(reset) / 1000 <= now;
      });
      if (force || !Number.isFinite(fetched) || fetched > now + 5 || now - fetched >= TTL_SECONDS || expiredWindow ||
          !window(snapshot, '5h', now) || !window(snapshot, '7d', now)) {
        try {
          const usage = await queryOpenAIQuota(request, account, db, false, false);
          snapshot = quotaWindowUpdates(usage);
          fetched = usage.fetched_at;
          cached = false;
          try {
            await db.rpc('s2a_personal_windows_save', { p_account_id: account.id, p_version: account.credential_version, p_fetched_at: fetched, p_windows: snapshot });
          } catch { console.warn('usage_snapshot_save_failed'); }
        } catch (cause) {
          error = cause instanceof HttpError ? cause.code : 'quota_unavailable';
        }
      }
      const sampledAt = Math.floor(Date.now() / 1000);
      const fiveHour = window(snapshot, '5h', sampledAt), sevenDay = window(snapshot, '7d', sampledAt);
      const age = Number.isFinite(fetched) ? Math.max(0, sampledAt - fetched) : null;
      return {
        account_id: account.id, account_name: account.name ?? `Account ${account.id}`, platform: 'openai',
        supported: true,
        windows: [fiveHour && { id: 'five_hour', ...fiveHour }, sevenDay && { id: 'seven_day', ...sevenDay }].filter(Boolean),
        five_hour: fiveHour, seven_day: sevenDay,
        fetched_at: Number.isFinite(fetched) ? new Date(fetched * 1000).toISOString() : null,
        age_seconds: age, cached,
        stale: !!error || age === null || age >= TTL_SECONDS || !fiveHour || !sevenDay,
        ...(error ? { error } : {}),
      };
    })));
  }
  const response = json(200, { object: 'subscription.usage', cache_ttl_seconds: TTL_SECONDS, accounts });
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
}

async function providerUsage(request: Request, account: UsageAccount, db: Database, force: boolean) {
  let supported = supportsProviderUsage(account);
  let windows: UsageWindow[] = cachedProviderWindows(account.usage_snapshot?.windows);
  let fetched = account.usage_snapshot?.fetched_at;
  let cached = true, error: string | undefined;
  const now = Math.floor(Date.now() / 1000);
  if (!supported) { windows = []; fetched = undefined; error = 'quota_not_supported'; }
  else if (force || typeof fetched !== 'number' || !Number.isFinite(fetched) || fetched > now + 5 || now - fetched >= TTL_SECONDS || !windows.length || windows.some(row => row.reset_at && Date.parse(row.reset_at) <= now * 1000)) {
    try {
      windows = await queryProviderUsage(request, account, db);
      fetched = Math.floor(Date.now() / 1000);
      cached = false;
      try { await db.rpc('s2a_personal_usage_save', { p_account_id: account.id, p_version: account.credential_version, p_fetched_at: fetched, p_windows: windows }); }
      catch { console.warn('usage_snapshot_save_failed'); }
    } catch (cause) {
      error = cause instanceof HttpError ? cause.code : 'quota_unavailable';
      if (error === 'quota_not_supported') { supported = false; windows = []; fetched = undefined; }
    }
  }
  const sampled = Math.floor(Date.now() / 1000);
  const age = typeof fetched === 'number' && Number.isFinite(fetched) ? Math.max(0, sampled - fetched) : null;
  const publicWindow = (id: string) => {
    const row = windows.find(value => value.id === id);
    if (!row) return null;
    const { id: _, model: __, ...value } = row;
    return { ...value, reset_after_seconds: row.reset_at === null ? null : Math.max(0, Math.ceil(Date.parse(row.reset_at) / 1000 - sampled)) };
  };
  return {
    account_id: account.id, account_name: account.name ?? `Account ${account.id}`, platform: account.platform,
    supported, windows, five_hour: publicWindow('five_hour'), seven_day: publicWindow('seven_day'),
    fetched_at: age === null ? null : new Date(fetched! * 1000).toISOString(),
    age_seconds: age, cached, stale: supported && (!!error || age === null || age >= TTL_SECONDS || !windows.length),
    ...(error ? { error } : {}),
  };
}
