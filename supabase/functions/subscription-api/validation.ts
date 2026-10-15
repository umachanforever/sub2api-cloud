import { grokOrigin } from './grok_config.ts';
import { quotaDisplaySnapshot, quotaWindowMetadata } from "./openai_quota_values.ts";
import { autoResetThreshold } from "./openai_auto_reset_values.ts";
import { pauseThreshold } from "./openai_quota_pause.ts";
import { modelMetadataSnapshot } from "./model_capabilities.ts";
import {
  type AccountCredentials,
  expiresAtMillis,
  type OAuthCredentials,
} from "./gateway.ts";
import { modelAllowlist } from "./model_policy.ts";
import { HttpError } from "./db.ts";

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new HttpError(400, "invalid_id");
  }
  return value.toLowerCase();
}
export function label(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100) {
    throw new HttpError(400, "invalid_name");
  }
  return value.trim();
}
export function accountNotes(value: unknown = ""): string {
  if (value === null) return "";
  if (typeof value !== "string" || value.length > 10000) throw new HttpError(400, "invalid_notes");
  return value;
}
export function accountMetadata(value: unknown = {},platform?:string,type?:string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_extra");
  const result: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(value)) {
    if(name==='codex_auto_reset_credit_state')continue;
    if(['auto_pause_5h_disabled','auto_pause_7d_disabled'].includes(name)){result[name]=boolean(field);continue;}
    if(['auto_pause_5h_threshold','auto_pause_7d_threshold'].includes(name)){result[name]=pauseThreshold(field);continue;}
    if(name==='auto_reset_credit_enabled'){result[name]=boolean(field);continue;}
    if(['auto_reset_credit_5h_threshold','auto_reset_credit_7d_threshold'].includes(name)){result[name]=autoResetThreshold(field);continue;}
    if(/^codex_(?:(?:5h|7d)_(?:used_percent|reset_after_seconds|reset_at|window_minutes)|usage_updated_at)$/.test(name)) {result[name]=quotaWindowMetadata(name,field);continue;}
    if(["codex_reset_credit_snapshot","codex_credits_snapshot"].includes(name)) {result[name]=quotaDisplaySnapshot(name,field);continue;}
    if(name==="upstream_model_metadata") {result[name]=modelMetadataSnapshot(field);continue;}
    if (!["email", "name", "plan_type", "privacy_mode", "chatgpt_user_id", "organization_id"].includes(name)) throw new HttpError(501, "advanced_account_extra_not_ported");
    if (typeof field !== "string" || field.length > 512) throw new HttpError(400, "invalid_extra");
    result[name] = field;
  }
  if(result.auto_reset_credit_enabled===true){result.auto_reset_credit_5h_threshold??=1;result.auto_reset_credit_7d_threshold??=1;}
  if(platform!==undefined && Object.keys(result).some(name=>name.startsWith('auto_reset_credit_')) && (platform!=='openai' || type!=='oauth'))throw new HttpError(400,'invalid_auto_reset_account');
  if(platform!==undefined && Object.keys(result).some(name=>/^auto_pause_(?:5h|7d)_/.test(name)) && platform!=='openai')throw new HttpError(400,'invalid_quota_pause_account');
  return result;
}
export function oauthTicketId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("oauth_ticket_id" in value)) return undefined;
  if (Object.keys(value).length !== 1) throw new HttpError(400, "oauth_ticket_mixed_credentials");
  return uuid((value as Record<string, unknown>).oauth_ticket_id);
}
export function integer(value: unknown, min: number, max: number): number {
  if (
    !Number.isInteger(value) || (value as number) < min ||
    (value as number) > max
  ) throw new HttpError(400, "invalid_number");
  return value as number;
}
export function money(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000_000 || Number(value.toFixed(8)) !== value) throw new HttpError(400, "invalid_amount");
  return value;
}
export function rateMultiplier(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000 || Number(value.toFixed(6)) !== value) throw new HttpError(400, "invalid_rate_multiplier");
  return value;
}
export function loadFactor(value: unknown): number | null {
  if(value===null)return null;
  const factor=integer(value,-2147483648,10000);
  return factor>0?factor:null;
}
export function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new HttpError(400, "invalid_boolean");
  return value;
}
export function expiry(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
    Date.parse(value) <= Date.now()
  ) throw new HttpError(400, "invalid_expiry");
  return new Date(value).toISOString();
}
export function ipList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) throw new HttpError(400, "invalid_ip_list");
  return value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim() || entry.length > 64 ||
        !/^[0-9a-fA-F:.]+(?:\/\d{1,3})?$/.test(entry.trim())) {
      throw new HttpError(400, "invalid_ip_list");
    }
    const value = entry.trim();
    const prefix = value.includes("/") ? Number(value.split("/")[1]) : null;
    const address = value.split("/")[0];
    const ipv4 = address.includes(".");
    if (prefix !== null && (!Number.isInteger(prefix) || prefix < 0 || prefix > (ipv4 ? 32 : 128))) {
      throw new HttpError(400, "invalid_ip_list");
    }
    return value;
  });
}
export function accountExpiry(value: unknown): string | null {
  if (value === null || value === 0) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 253402300799) throw new HttpError(400, "invalid_account_expiry");
  return new Date(value * 1000).toISOString();
}
export function parseCredentials(source: unknown): OAuthCredentials {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new HttpError(400, "invalid_credentials");
  }
  const input = source as Record<string, unknown>;
  const credentials: Record<string, unknown> = {};
  for (const name of ["access_token", "refresh_token", "chatgpt_account_id"]) {
    if (typeof input[name] !== "string" || !(input[name] as string).trim()) {
      throw new HttpError(400, `missing_${name}`);
    }
    if((input[name] as string).length>(name==="chatgpt_account_id"?512:32768) || /[\x00-\x1f\x7f]/.test(input[name] as string))throw new HttpError(400, `invalid_${name}`);
    credentials[name] = (input[name] as string).trim();
  }
  if (input.client_id !== undefined) {
    if (typeof input.client_id !== "string" || !input.client_id.trim() || input.client_id.length>512 || /[\x00-\x1f\x7f]/.test(input.client_id)) {
      throw new HttpError(400, "invalid_client_id");
    }
    credentials.client_id = input.client_id.trim();
  }
  if (input.expires_at !== undefined) {
    if (!["string", "number"].includes(typeof input.expires_at)) {
      throw new HttpError(400, "invalid_expiry");
    }
    const expiry = expiresAtMillis(input.expires_at as string | number);
    if (!Number.isFinite(expiry) || expiry! <= 0) {
      throw new HttpError(400, "invalid_expiry");
    }
    credentials.expires_at = input.expires_at;
  }
  return credentials as OAuthCredentials;
}
export async function readBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid_request");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_048_576) {
        await reader.cancel();
        throw new HttpError(413, "request_too_large");
      }
      chunks.push(value);
    }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = JSON.parse(new TextDecoder().decode(data));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "invalid_request");
    }
    return body;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_request");
  } finally {
    reader.releaseLock();
  }
}
export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function newKey(): string {
  return "sk-s2a-" +
    Array.from(
      crypto.getRandomValues(new Uint8Array(32)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
}

export function parseAccountCredentials(
  source: unknown,
  platform: unknown = "openai",
  type: unknown = "oauth",
): AccountCredentials {
  if (!["openai", "anthropic", "gemini", "grok"].includes(platform as string)) {
    throw new HttpError(501, "unsupported_platform");
  }
  if (type === "oauth" && platform === "openai") {
    return parseCredentials(source);
  }
  if (type !== "apikey") throw new HttpError(501, "unsupported_account_type");
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new HttpError(400, "invalid_credentials");
  }
  const input = source as Record<string, unknown>;
  if (
    typeof input.api_key !== "string" || !input.api_key.trim() ||
    input.api_key.length > 8192 || /[\r\n]/.test(input.api_key)
  ) throw new HttpError(400, "missing_api_key");
  for (const [name, value] of Object.entries(input)) {
    if (["api_key", "base_url"].includes(name)) continue;
    if (
      name === "tier_id" && platform === "gemini" &&
      ["aistudio_free", "aistudio_paid"].includes(value as string)
    ) continue;
    if (
      value === null || value === undefined || value === false ||
      value === "" || (Array.isArray(value) && value.length === 0) ||
      (typeof value === "object" && value !== null && !Array.isArray(value) &&
        Object.keys(value).length === 0)
    ) continue;
    throw new HttpError(501, "unsupported_credential_option");
  }
  const credentials: { api_key: string; base_url?: string } = {
    api_key: input.api_key.trim(),
  };
  if (platform === "grok") {
    credentials.base_url = grokOrigin(input.base_url);
    return credentials;
  }
  if (input.base_url !== undefined && input.base_url !== "") {
    if (typeof input.base_url !== "string") {
      throw new HttpError(400, "invalid_base_url");
    }
    const official = {
      openai: "https://api.openai.com",
      anthropic: "https://api.anthropic.com",
      gemini: "https://generativelanguage.googleapis.com",
    }[platform as "openai" | "anthropic" | "gemini"];
    let url: URL;
    try {
      url = new URL(input.base_url);
    } catch {
      throw new HttpError(400, "invalid_base_url");
    }
    const path = url.pathname.replace(/\/$/, "");
    if (
      url.origin !== official || url.username || url.password || url.search ||
      url.hash ||
      !["", platform === "gemini" ? "/v1beta" : "/v1"].includes(path)
    ) throw new HttpError(501, "custom_base_url_unsupported");
    credentials.base_url = official;
  }
  return credentials;
}

export const GROUP_OPTION_FIELDS = ["is_exclusive", "require_privacy_set", "model_allowlist", "rpm_limit", "description", "sort_order", "subscription_type", "daily_limit_usd", "weekly_limit_usd", "monthly_limit_usd"];
export function groupOptions(input: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const field of GROUP_OPTION_FIELDS) {
    if (input[field] === undefined) continue;
    if (field === "model_allowlist") result[field] = modelAllowlist(input[field]);
    else if (["is_exclusive","require_privacy_set"].includes(field)) result[field] = boolean(input[field]);
    else if (field === "description") {
      if (input[field] !== null && (typeof input[field] !== "string" || (input[field] as string).length > 10000 || (input[field] as string).includes("\0"))) throw new HttpError(400, "invalid_group_description");
      result[field] = input[field];
    } else if (field === "rpm_limit") result[field] = integer(input[field], 0, 1000000);
    else if (field === "sort_order") result[field] = integer(input[field], -2147483648, 2147483647);
    else if (field === "subscription_type") {
      if (!["standard", "subscription"].includes(String(input[field]))) throw new HttpError(400, "invalid_subscription_type");
      result[field] = input[field];
    } else result[field] = input[field] === null ? null : money(input[field]);
  }
  return result;
}

export function pageSlug(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new HttpError(400, "invalid_page_slug");
  return value;
}


export const KEY_WINDOW_FIELDS = "rate_limit_5h,rate_limit_1d,rate_limit_7d,usage_5h,usage_1d,usage_7d,window_5h_start,window_1d_start,window_7d_start";
export function keyWindowLimits(input: Record<string, unknown>) {
  const result: Record<string, number> = {};
  for (const field of ["rate_limit_5h", "rate_limit_1d", "rate_limit_7d"]) {
    if (input[field] !== undefined && input[field] !== null) result[field] = money(input[field]);
  }
  return result;
}

export function accountPrivacyFilter(params:URLSearchParams):string {
  const mode=params.get("privacy_mode");
  if(!mode)return "";
  if(mode.length>512||/[\x00-\x1f\x7f]/.test(mode))throw new HttpError(400,"invalid_privacy_mode_filter");
  if(mode==="__unset__")return '&or=(extra->>privacy_mode.is.null,extra->>privacy_mode.eq."")';
  return `&extra->>privacy_mode=eq.${encodeURIComponent(mode)}`;
}
