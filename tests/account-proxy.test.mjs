import assert from "node:assert/strict";
import test from "node:test";
import { Database } from "../supabase/functions/subscription-api/db.ts";
import {
  encryptCredentials,
  decryptSecret,
} from "../supabase/functions/subscription-api/credential_store.ts";
import {
  accountFetch,
  proxyFetcher,
} from "../supabase/functions/subscription-api/account_proxy.ts";
import { createHandler } from "./handler.mjs";
import { credentialsFor } from "../supabase/functions/subscription-api/accounts.ts";
const id = "11111111-1111-4111-8111-111111111111",
  accountId = "22222222-2222-4222-8222-222222222222";
const config = {
  url: "https://db",
  serviceKey: "private",
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  adminIds: [id],
};
const request = (path, body) =>
  new Request("https://gateway/api/v1" + path, {
    method: "POST",
    headers: { authorization: "Bearer session", "x-s2a-frontend": "1" },
    body: JSON.stringify(body),
  });
function nativeClient(t) {
  const previous = globalThis.Deno;
  let closed = 0,
    created = 0;
  globalThis.Deno = {
    createHttpClient(options) {
      created++;
      assert.equal(options.proxy.url, "socks5h://proxy.example.com:1080");
      assert.equal(options.proxy.basicAuth.password, "proxy-password");
      return {
        close() {
          closed++;
        },
      };
    },
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.Deno;
    else globalThis.Deno = previous;
  });
  return () => ({ closed, created });
}
async function proxyRow() {
  return {
    id: 7,
    protocol: "socks5h",
    host: "proxy.example.com",
    port: 1080,
    username: "fixture",
    ...(await encryptCredentials(
      { password: "proxy-password" },
      config.encryptionKey,
    )),
  };
}
test("Vault accounts use native proxy routes with lossless IDs and no legacy secret decryption", async (t) => {
  const state = nativeClient(t);
  let calls = 0;
  const db = new Database(
    { ...config, encryptionKey: "unused" },
    async (url, init) => {
      if (String(url).endsWith("s2a_gateway_proxy_route")) {
        calls++;
        assert.equal(JSON.parse(init.body).p_id, "9007199254740993");
        assert.equal(init.client, undefined);
        return Response.json({
          proxy: {
            id: "9007199254740993",
            protocol: "socks5h",
            host: "proxy.example.com",
            port: 1080,
            username: "fixture",
            password: "proxy-password",
          },
        });
      }
      assert.equal(String(url), "https://provider.example");
      assert.ok(init.client);
      return new Response("native");
    },
  );
  assert.equal(
    await (
      await accountFetch(
        db,
        { credential_storage: "vault", proxy_id: "9007199254740993" },
        "https://provider.example",
      )
    ).text(),
    "native",
  );
  assert.deepEqual(state(), { created: 1, closed: 1 });
  assert.equal(calls, 1);
  for (const proxy_id of [
    "0",
    "-1",
    "1.5",
    "9223372036854775808",
    9007199254740992,
  ])
    await assert.rejects(
      () =>
        accountFetch(
          db,
          { credential_storage: "vault", proxy_id },
          "https://provider.example",
        ),
      /invalid_proxy_id/,
    );
  assert.equal(calls, 1);
});
test("only provider fetches use native proxy clients; direct fallback and Request inputs preserve fetch semantics", async (t) => {
  const state = nativeClient(t),
    row = await proxyRow();
  let direct = false;
  const db = new Database(config, async (url, init) => {
    if (String(url).endsWith("s2a_proxy_route")) {
      assert.equal(init.client, undefined);
      return Response.json({ proxy: direct ? null : row });
    }
    assert.equal(!!init?.client, !direct);
    return new Response("streamed");
  });
  const response = await accountFetch(
    db,
    { proxy_id: 7 },
    "https://provider.example",
  );
  assert.equal(state().closed, 0);
  assert.equal(await response.text(), "streamed");
  assert.deepEqual(state(), { created: 1, closed: 1 });
  direct = true;
  assert.equal(
    await (
      await proxyFetcher(db, 7)(new Request("https://provider.example"))
    ).text(),
    "streamed",
  );
  assert.equal(state().created, 1);
});
test("owned credential refresh retains the reservation proxy while rotating credentials", async (t) => {
  const state = nativeClient(t),
    row = await proxyRow(),
    sealed = await encryptCredentials(
      {
        access_token: "old",
        refresh_token: "refresh",
        chatgpt_account_id: "fixture",
        expires_at: 1,
      },
      config.encryptionKey,
    ),
    account = { id: accountId, credential_version: 1, proxy_id: 7, ...sealed };
  const db = new Database(config, async (url, init) => {
    if (String(url).endsWith("s2a_refresh_acquire")) return Response.json(true);
    if (String(url).endsWith("s2a_proxy_route"))
      return Response.json({ proxy: row });
    if (String(url).startsWith("https://auth.openai.com/")) {
      assert.ok(init.client);
      return Response.json({
        access_token: "new",
        refresh_token: "next",
        expires_in: 3600,
      });
    }
    if (
      String(url).endsWith("s2a_refresh_save") ||
      String(url).endsWith("s2a_refresh_release")
    )
      return Response.json(true);
    assert.ok(String(url).includes("s2a_accounts"));
    return Response.json([]);
  });
  assert.equal((await credentialsFor(db, account)).access_token, "new");
  assert.equal(account.proxy_id, 7);
  assert.deepEqual(state(), { created: 1, closed: 1 });
});
