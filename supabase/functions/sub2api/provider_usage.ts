import {antigravityUserAgent} from './antigravity_identity.ts';
import { accountFetch } from './account_proxy.ts';
import { catalogJSON } from './account_models.ts';
import { credentialsFor } from './accounts.ts';
import { Database, HttpError } from './db.ts';
import { grokHeaders } from './grok_config.ts';
import type { QuotaAccount } from './openai_quota.ts';

export type UsageWindow = {
  id: string; model?: string; used_percent: number; remaining_percent: number;
  window_seconds: number | null; reset_at: string | null;
};
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const percent = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const date = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
function window(id: string, used: unknown, reset: unknown, seconds: number | null, model?: string): UsageWindow | undefined {
  if (!percent(used)) return;
  return { id, ...(model ? { model } : {}), used_percent: used, remaining_percent: Math.max(0, 100 - used), window_seconds: seconds, reset_at: date(reset) };
}
export function normalizeProviderWindows(platform: string, raw: Record<string, any>): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const add = (value: UsageWindow | undefined) => { if (value) windows.push(value); };
  if (platform === 'anthropic') {
    for (const id of ['five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus', 'seven_day_overage_included']) {
      const row = object(raw[id]);
      add(window(id, row.utilization, row.resets_at, id === 'five_hour' ? 18000 : 604800));
    }
  } else if (platform === 'antigravity') {
    for (const [model, value] of Object.entries(object(raw.models)).slice(0, 100)) {
      const quota = object(object(value).quotaInfo), fraction = quota.remainingFraction;
      if (model.length > 200 || !percent(fraction) || fraction > 1) continue;
      add(window(model, (1 - fraction) * 100, quota.resetTime, null, model));
    }
  } else if (platform === 'gemini') {
    for (const [index, value] of (Array.isArray(raw.buckets) ? raw.buckets : []).slice(0, 100).entries()) {
      const row = object(value), fraction = row.remainingFraction;
      const model = typeof row.modelId === 'string' && row.modelId.length <= 200 ? row.modelId : undefined;
      if (!percent(fraction) || fraction > 1) continue;
      add(window(`bucket_${index}`, (1 - fraction) * 100, row.resetTime, null, model));
    }
  } else if (platform === 'grok') {
    const config = object(raw.config), period = object(config.currentPeriod);
    add(window(period.type === 'monthly' ? 'monthly' : 'seven_day', config.creditUsagePercent, period.end, period.type === 'weekly' ? 604800 : null));
    const monthly = object(object(raw.monthly).config);
    const amount = (value: unknown): number | undefined => {
      const raw = typeof value === 'object' ? object(value).val : value;
      if (typeof raw !== 'number' && (typeof raw !== 'string' || !raw.trim())) return;
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
    };
    const limit = amount(monthly.monthlyLimit), used = amount(monthly.used);
    if (limit && used !== undefined) add(window('monthly', used / limit * 100, monthly.billingPeriodEnd ?? object(monthly.currentPeriod).end, null));
  }
  return windows;
}
export function supportsProviderUsage(account: QuotaAccount): boolean {
  return account.type === 'oauth' && ['anthropic', 'antigravity', 'gemini', 'grok'].includes(account.platform);
}
export async function queryProviderUsage(request: Request, account: QuotaAccount, db: Database): Promise<UsageWindow[]> {
  let credentials = await credentialsFor(db, account);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]);
  const fetch = async (monthly = false) => {
    const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${credentials.access_token}` });
    let url: string, body: string | undefined;
    switch (account.platform) {
      case 'anthropic':
        url = 'https://api.anthropic.com/api/oauth/usage';
        headers.set('anthropic-beta', 'oauth-2025-04-20');
        headers.set('user-agent', 'claude-code/2.1.7');
        break;
      case 'antigravity':
      case 'gemini': {
        if (account.platform === 'gemini' && (credentials as Record<string, unknown>).oauth_type === 'ai_studio') throw new HttpError(422, 'quota_not_supported');
        const project = (credentials as Record<string, unknown>).project_id;
        if (typeof project !== 'string' || !project.trim() || project.length > 512) throw new HttpError(422, 'quota_project_required');
        url = 'https://cloudcode-pa.googleapis.com/v1internal:' + (account.platform === 'antigravity' ? 'fetchAvailableModels' : 'retrieveUserQuota');
        body = JSON.stringify({ project });
        headers.set('user-agent', account.platform === 'antigravity' ? antigravityUserAgent : 'google-cloud-sdk');
        break;
      }
      case 'grok':
        url = 'https://cli-chat-proxy.grok.com/v1/billing' + (monthly ? '' : '?format=credits');
        grokHeaders(headers, 'https://cli-chat-proxy.grok.com');
        break;
      default: throw new HttpError(422, 'quota_not_supported');
    }
    return accountFetch(db, account, url, { method: body === undefined ? 'GET' : 'POST', headers, body, signal, redirect: 'error' });
  };
  const read = async (monthly = false): Promise<Record<string, any>> => {
    let response: Response;
    try {
      response = await fetch(monthly);
      if (response.status === 401) { await response.body?.cancel(); credentials = await credentialsFor(db, account, credentials.access_token); response = await fetch(monthly); }
    } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(502, 'quota_request_failed'); }
    if (!response.ok) { const status = response.status; await response.body?.cancel(); throw new HttpError([401, 403, 429].includes(status) ? status : 502, 'quota_upstream_error'); }
    try { return await catalogJSON(response, false, 512 * 1024); } catch { throw new HttpError(502, 'invalid_provider_quota'); }
  };
  const raw = await read();
  if (account.platform === 'grok') raw.monthly = await read(true);
  const windows = normalizeProviderWindows(account.platform, raw);
  if (!windows.length) throw new HttpError(422, 'quota_unavailable');
  return windows;
}

// Cached records cross a trust boundary too; expose only the public quota schema.
export function cachedProviderWindows(value: unknown): UsageWindow[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap(raw => {
    const row = object(raw);
    if (typeof row.id !== 'string' || row.id.length > 200 || !row.id) return [];
    const model = typeof row.model === 'string' && row.model.length <= 200 ? row.model : undefined;
    const seconds = typeof row.window_seconds === 'number' && Number.isFinite(row.window_seconds) && row.window_seconds > 0 ? row.window_seconds : null;
    const result = window(row.id, row.used_percent, row.reset_at, seconds, model);
    return result ? [result] : [];
  });
}
