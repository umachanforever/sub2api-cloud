import type { Account } from "./accounts.ts";
import { proxyFetcher } from "./account_proxy.ts";
import { decryptCredentials, isVaultCredentials } from "./credential_store.ts";
import { Database, HttpError } from "./db.ts";

export async function disableOpenAITraining(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!token) return "";
  try {
    const response = await fetchImpl(
      "https://chatgpt.com/backend-api/settings/account_user_setting?feature=training_allowed&value=false",
      {
        method: "PATCH",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          authorization: `Bearer ${token}`,
          origin: "https://chatgpt.com",
          referer: "https://chatgpt.com/",
          accept: "application/json",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
          "sec-fetch-dest": "empty",
        },
      },
    );
    if (response.ok) {
      await response.body?.cancel();
      return "training_off";
    }
    // Bound challenge inspection; provider bodies must never enter logs or API responses.
    let body = "";
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (body.length < 8192) {
          const chunk = await reader.read();
          if (chunk.done) break;
          body += new TextDecoder().decode(
            chunk.value.slice(0, 8192 - body.length),
          );
        }
      } finally {
        await reader.cancel();
      }
    }
    return [403, 503].includes(response.status) &&
      (response.headers.get("cf-mitigated") === "challenge" ||
        /cloudflare|cf-|just a moment/i.test(body))
      ? "training_set_cf_blocked"
      : "training_set_failed";
  } catch {
    return "training_set_failed";
  }
}

export async function ensureOpenAIPrivacy(
  db: Database,
  id: string,
  force = false,
  account?: Account,
) {
  if (account && isVaultCredentials(account)) {
    const previous = account.privacy_mode;
    if (
      !force &&
      previous != null &&
      ![
        "",
        "failed",
        "cf_blocked",
        "training_set_failed",
        "training_set_cf_blocked",
      ].includes(String(previous))
    )
      return;
    const credentials = await decryptCredentials(
      account,
      db.config.encryptionKey,
    );
    const legacyMode = await disableOpenAITraining(
      credentials.access_token,
      proxyFetcher(db, account.proxy_id, true),
    );
    const mode =
      legacyMode === "training_set_cf_blocked"
        ? "cf_blocked"
        : legacyMode === "training_set_failed"
          ? "failed"
          : legacyMode;
    const saved = await db.rpc<boolean>("s2a_gateway_privacy_save", {
      p_id: id,
      p_version: account.credential_version,
      p_previous: previous ?? null,
      p_mode: mode,
    });
    if (!saved) {
      if (force) throw new HttpError(409, "account_privacy_changed_retry");
      return;
    }
    account.privacy_mode = mode;
    return;
  }
  const rows = await db.rest<
    {
      id: string;
      platform: string;
      type: string;
      credential_version: number;
      proxy_id?: number | null;
      ciphertext: string;
      iv: string;
      extra: Record<string, unknown>;
    }[]
  >(
    `s2a_accounts?id=eq.${id}&select=id,platform,type,credential_version,ciphertext,iv,extra,proxy_id`,
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, "account_not_found");
  if (row.platform !== "openai" || row.type !== "oauth") {
    if (force) throw new HttpError(400, "account_privacy_not_supported");
    return;
  }
  const previous = row.extra?.privacy_mode;
  if (
    !force &&
    previous != null &&
    !["", "training_set_failed", "training_set_cf_blocked"].includes(
      String(previous).trim(),
    )
  )
    return;
  const credentials = await decryptCredentials(row, db.config.encryptionKey);
  if (!credentials.access_token) {
    if (force) throw new HttpError(400, "access_token_required");
    return;
  }
  const mode = await disableOpenAITraining(
    credentials.access_token,
    proxyFetcher(db, row.proxy_id),
  );
  const saved = await db.rpc<boolean>("s2a_account_privacy_save", {
    p_account_id: id,
    p_version: row.credential_version,
    p_previous: previous ?? null,
    p_mode: mode,
  });
  if (!saved && force)
    throw new HttpError(409, "account_privacy_changed_retry");
}
