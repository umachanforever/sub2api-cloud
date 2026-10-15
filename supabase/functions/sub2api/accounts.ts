import { refreshGrokCredentials } from './grok_oauth.ts';
import { proxyFetcher } from "./account_proxy.ts";
import { refreshAnthropicCredentials } from "./anthropic_oauth.ts";
import { refreshGoogleCredentials } from "./google_oauth.ts";
import {
  decryptCredentials,
  encryptCredentials,
  type StoredCredentials,
  isVaultCredentials,
} from "./credential_store.ts";
import { ensureOpenAIPrivacy } from "./openai_privacy.ts";
import { Database, HttpError } from "./db.ts";
import {
  type OAuthCredentials,
  expiresAtMillis,
  refreshCredentials,
  shouldRefresh,
} from "./gateway.ts";

export type Account = StoredCredentials & {
  codex_settings?: import("./codex_identity.ts").CodexSettings;
  id: string;
  platform?: import("./gateway.ts").Platform;
  credential_version: number;
  proxy_id?: number | string | null;
  privacy_mode?: unknown;
};

async function currentAccount(
  db: Database,
  account: Account,
): Promise<Account> {
  if (!isVaultCredentials(account)) {
    const rows = await db.rest<Account[]>(
      `s2a_accounts?id=eq.${account.id}&select=id,ciphertext,iv,credential_version`,
    );
    if (!rows[0]) throw new HttpError(503, "account_unavailable");
    return rows[0];
  }
  const row = await db.rpc<{
    id?: string;
    credential_version?: number;
    credentials?: Record<string, unknown>;
    privacy_mode?: unknown;
  }>("s2a_gateway_account_snapshot", { p_id: account.id });
  if (
    !row ||
    row.id !== account.id ||
    !Number.isSafeInteger(row.credential_version) ||
    row.credential_version! < 1 ||
    !row.credentials ||
    typeof row.credentials !== "object" ||
    Array.isArray(row.credentials)
  )
    throw new HttpError(503, "account_unavailable");
  // Refresh reads must not replace the proxy or provider frozen by request admission.
  return {
    id: account.id,
    credential_storage: "vault",
    credentials: row.credentials,
    credential_version: row.credential_version!,
    privacy_mode: row.privacy_mode,
  };
}

export async function credentialsFor(
  db: Database,
  account: Account,
  rejectedToken?: string,
): Promise<OAuthCredentials> {
  const latest =
    rejectedToken === undefined ? account : await currentAccount(db, account);
  let current = await decryptCredentials(latest, db.config.encryptionKey);
  if (
    !(account.platform === "grok" && current.refresh_token && expiresAtMillis(current.expires_at) === undefined) &&
    !shouldRefresh(current) &&
    (rejectedToken === undefined || rejectedToken !== current.access_token)
  ) {
    Object.assign(account, latest);
    return current;
  }
  const lockId = crypto.randomUUID();
  const acquired = await db.rpc<boolean>(
    isVaultCredentials(account)
      ? "s2a_gateway_refresh_acquire"
      : "s2a_refresh_acquire",
    {
      ...(isVaultCredentials(account)
        ? { p_id: account.id }
        : { p_account_id: account.id }),
      p_version: latest.credential_version,
      p_lock_id: lockId,
    },
  );
  if (acquired) {
    try {
      const fetcher = proxyFetcher(db, account.proxy_id, isVaultCredentials(account));
      const refreshed = account.platform === "gemini" || account.platform === "antigravity"
        ? await refreshGoogleCredentials(current, fetcher, db.config.googleOAuth, account.platform === "antigravity" ? "antigravity" : undefined)
        : await (account.platform === "grok" ? refreshGrokCredentials : account.platform === "anthropic" ? refreshAnthropicCredentials : refreshCredentials)(current, fetcher);
      if (isVaultCredentials(account) && refreshed.expires_at !== undefined) {
        const expiry = expiresAtMillis(refreshed.expires_at);
        if (expiry === undefined) throw new HttpError(502, "invalid_oauth_refresh_response");
        refreshed.expires_at = new Date(expiry).toISOString();
      }
      const encrypted = isVaultCredentials(account)
        ? null
        : await encryptCredentials(refreshed, db.config.encryptionKey);
      const saved = isVaultCredentials(account)
        ? await db.rpc<boolean>("s2a_gateway_refresh_save", {
            p_id: account.id,
            p_version: latest.credential_version,
            p_lock_id: lockId,
            p_credentials: refreshed,
          })
        : await db.rpc<boolean>("s2a_refresh_save", {
            p_account_id: account.id,
            p_lock_id: lockId,
            p_ciphertext: encrypted!.ciphertext,
            p_iv: encrypted!.iv,
          });
      if (!saved) throw new HttpError(503, "credential_persistence_failed");
      Object.assign(
        account,
        latest,
        isVaultCredentials(account) ? { credentials: refreshed } : encrypted,
        { credential_version: latest.credential_version + 1 },
      );
      // Credentials are already durable; privacy failure must not fail their rotation.
      if (!account.platform || account.platform === "openai") {
        await ensureOpenAIPrivacy(db, account.id, false, account).catch(() =>
          console.warn("account_privacy_update_failed"),
        );
      }
      return refreshed;
    } finally {
      await db.rpc(
        isVaultCredentials(account)
          ? "s2a_gateway_refresh_release"
          : "s2a_refresh_release",
        {
          ...(isVaultCredentials(account)
            ? { p_id: account.id }
            : { p_account_id: account.id }),
          p_lock_id: lockId,
        },
      );
    }
  }
  const deadline = Date.now() + 10_000;
  for (let attempt = 0; attempt < 20 && Date.now() < deadline; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const row = await currentAccount(db, account);
    if (row.credential_version !== latest.credential_version) {
      current = await decryptCredentials(row, db.config.encryptionKey);
      Object.assign(account, row);
      return current;
    }
  }
  throw new HttpError(503, "credential_refresh_busy");
}
