import assert from "node:assert/strict";
import test from "node:test";
import { credentialsFor } from "../supabase/functions/sub2api/accounts.ts";
import {
  decryptCredentials,
  decryptApiKeyCredentials,
} from "../supabase/functions/sub2api/credential_store.ts";
import { Database } from "../supabase/functions/sub2api/db.ts";
const config = {
  url: "https://db.example",
  serviceKey: "service",
  encryptionKey: "unused",
  adminIds: [],
};
const fixture = (patch = {}) => ({
  id: "42",
  credential_storage: "vault",
  credential_version: 3,
  privacy_mode: "training_off",
  proxy_id: null,
  credentials: {
    access_token: "old-access",
    refresh_token: "old-refresh",
    expires_at: 1,
    chatgpt_account_id: "provider-account",
    provider_metadata: "retained",
  },
  ...patch,
});
const snapshot = (account) => ({
  ...structuredClone(account),
  proxy_id: 999,
  platform: "different-provider",
});
function dbWith(handler) {
  return new Database(config, async (url, init) => {
    if (String(url).startsWith(config.url + "/rest/v1/rpc/"))
      return Response.json(
        await handler(String(url).split("/").at(-1), JSON.parse(init.body)),
      );
    return handler(String(url), init);
  });
}
test("Vault credential envelopes reuse provider validation without requiring an AES key", async () => {
  const account = fixture();
  const c = await decryptCredentials(account, "unused");
  c.access_token = "modified-copy";
  assert.equal(account.credentials.access_token, "old-access");
  assert.equal(
    (
      await decryptApiKeyCredentials(
        {
          credential_storage: "vault",
          credentials: {
            api_key: "provider-key",
            base_url: "https://provider.example",
          },
        },
        "unused",
      )
    ).api_key,
    "provider-key",
  );
  await assert.rejects(
    decryptApiKeyCredentials(
      { credential_storage: "vault", credentials: {} },
      "unused",
    ),
  );
  await assert.rejects(
    decryptCredentials(
      { credential_storage: "vault", credentials: [] },
      "unused",
    ),
  );
});
test("native refresh saves the complete document under its leased version before exposing the token", async () => {
  const account = fixture();
  const calls = [];
  let lock;
  const db = dbWith(async (name, args) => {
    calls.push(name);
    if (name === "s2a_gateway_account_snapshot") {
      assert.deepEqual(args, { p_id: "42" });
      return snapshot(account);
    }
    if (name === "s2a_gateway_refresh_acquire") {
      assert.equal(args.p_id, "42");
      assert.equal(args.p_version, 3);
      lock = args.p_lock_id;
      return true;
    }
    if (name === "https://auth.openai.com/oauth/token") {
      assert.equal(
        new URLSearchParams(args.body).get("refresh_token"),
        "old-refresh",
      );
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      });
    }
    if (name === "s2a_gateway_refresh_save") {
      assert.equal(args.p_id, "42");
      assert.equal(args.p_version, 3);
      assert.equal(args.p_lock_id, lock);
      assert.equal(args.p_credentials.provider_metadata, "retained");
      assert.equal(args.p_credentials.access_token, "new-access");
      assert.equal(account.credentials.access_token, "old-access");
      assert.equal(args.p_ciphertext, undefined);
      return true;
    }
    if (name === "s2a_gateway_refresh_release") {
      assert.deepEqual(args, { p_id: "42", p_lock_id: lock });
      return null;
    }
    throw Error("Unexpected operation " + name);
  });
  const c = await credentialsFor(db, account, "old-access");
  assert.equal(c.access_token, "new-access");
  assert.equal(account.credentials.access_token, "new-access");
  assert.equal(account.credential_version, 4);
  assert.equal(account.proxy_id, null);
  assert.deepEqual(calls, [
    "s2a_gateway_account_snapshot",
    "s2a_gateway_refresh_acquire",
    "https://auth.openai.com/oauth/token",
    "s2a_gateway_refresh_save",
    "s2a_gateway_refresh_release",
  ]);
});
test("a rejected native save never exposes an undurable refreshed token and releases ownership", async () => {
  const account = fixture();
  let released = false;
  const db = dbWith((name) => {
    if (name === "s2a_gateway_refresh_acquire") return true;
    if (name === "https://auth.openai.com/oauth/token")
      return Response.json({ access_token: "undurable", expires_in: 3600 });
    if (name === "s2a_gateway_refresh_save") return false;
    if (name === "s2a_gateway_refresh_release") {
      released = true;
      return null;
    }
    throw Error("Unexpected operation " + name);
  });
  await assert.rejects(credentialsFor(db, account), {
    code: "credential_persistence_failed",
  });
  assert.equal(released, true);
  assert.equal(account.credentials.access_token, "old-access");
  assert.equal(account.credential_version, 3);
});
test("reauthorization reuses the new native snapshot without refreshing or replacing the frozen proxy", async () => {
  const account = fixture({ proxy_id: 7 });
  const db = dbWith((name) => {
    assert.equal(name, "s2a_gateway_account_snapshot");
    return snapshot(
      fixture({
        credential_version: 9,
        credentials: {
          access_token: "reauthorized",
          refresh_token: "reauthorized-refresh",
          expires_at: Date.now() + 3600000,
        },
      }),
    );
  });
  assert.equal(
    (await credentialsFor(db, account, "old-access")).access_token,
    "reauthorized",
  );
  assert.equal(account.proxy_id, 7);
  assert.equal(account.credential_version, 9);
});
test("native refresh contention reuses the winner through service-only snapshots", async () => {
  const account = fixture();
  let reads = 0;
  const db = dbWith((name) => {
    if (name === "s2a_gateway_refresh_acquire") return false;
    assert.equal(name, "s2a_gateway_account_snapshot");
    reads++;
    return snapshot(
      fixture({
        credential_version: 4,
        credentials: {
          access_token: "winner",
          refresh_token: "winner-refresh",
          expires_at: Date.now() + 3600000,
        },
      }),
    );
  });
  assert.equal((await credentialsFor(db, account)).access_token, "winner");
  assert.equal(reads, 1);
  assert.equal(account.proxy_id, null);
});

test("the normal model gateway consumes native Vault API-key accounts without legacy credential reads", async () => {
  const { createHandler } = await import("./handler.mjs");
  let finished = false,
    provider = false;
  const handler = createHandler(config, async (url, init) => {
    const name = String(url).split("/").at(-1);
    if (name === "s2a_acquire")
      return Response.json({
        lease_id: "native-lease",
        account: {
          ...fixture(),
          type: "apikey",
          platform: "openai",
          credentials: {
            api_key: "native-provider-key",
            base_url: "https://api.openai.com",
          },
        },
      });
    if (String(url) === "https://api.openai.com/v1/models") {
      provider = true;
      assert.equal(
        new Headers(init.headers).get("authorization"),
        "Bearer native-provider-key",
      );
      return Response.json({
        object: "list",
        data: [{ id: "gpt-test", object: "model" }],
      });
    }
    if (name === "s2a_finish") {
      assert.equal(JSON.parse(init.body).p_lease_id, "native-lease");
      finished = true;
      return Response.json(true);
    }
    throw Error("Unexpected operation " + String(url));
  });
  const r = await handler(
    new Request("https://edge/v1/models", {
      headers: { authorization: "Bearer application-key" },
    }),
  );
  assert.equal(r.status, 200);
  assert.ok(provider);
  assert.ok(finished);
  assert.ok(!JSON.stringify(await r.json()).includes("native-provider-key"));
});

test("native privacy updates bind the exact credential version and preserve upstream failure vocabulary", async () => {
  const { ensureOpenAIPrivacy } = await import(
    "../supabase/functions/sub2api/openai_privacy.ts"
  );
  const account = fixture({ credential_version: 7, privacy_mode: null });
  let persisted;
  const db = dbWith((name, args) => {
    if (name.startsWith("https://chatgpt.com/backend-api/settings/"))
      return new Response("challenge", {
        status: 403,
        headers: { "cf-mitigated": "challenge" },
      });
    assert.equal(name, "s2a_gateway_privacy_save");
    persisted = args;
    return true;
  });
  await ensureOpenAIPrivacy(db, account.id, false, account);
  assert.deepEqual(persisted, {
    p_id: "42",
    p_version: 7,
    p_previous: null,
    p_mode: "cf_blocked",
  });
  assert.equal(account.privacy_mode, "cf_blocked");
});
test("invalid or missing native credential snapshots fail closed before provider access", async () => {
  for (const snapshot of [
    null,
    { error: "account_unavailable" },
    { id: "different", credential_version: 4, credentials: {} },
    { id: "42", credential_version: 0, credentials: {} },
    { id: "42", credential_version: 4, credentials: [] },
  ]) {
    const db = dbWith((name) => {
      assert.equal(name, "s2a_gateway_account_snapshot");
      return snapshot;
    });
    await assert.rejects(credentialsFor(db, fixture(), "old-access"), {
      code: "account_unavailable",
    });
  }
});
