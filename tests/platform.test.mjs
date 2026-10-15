import assert from "node:assert/strict";
import test from "node:test";
import { createHandler } from "./handler.mjs";

const config = {
  url: "https://project.supabase.co",
  serviceKey: "service-role",
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  adminIds: ["11111111-1111-4111-8111-111111111111"],
};

const adminId = config.adminIds[0];
const groupId = "33333333-3333-4333-8333-333333333333";
const accountId = "44444444-4444-4444-8444-444444444444";
const api = (path, method = "GET", body) =>
  new Request(`https://gateway${path}`, {
    method,
    headers: {
      authorization: "Bearer user-jwt",
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

for (const contentType of ["text/event-stream", null]) {
test(`Responses forwarding records usage with Content-Type ${contentType}`, async () => {
  const { encryptCredentials } = await import(
    "../supabase/functions/subscription-api/credential_store.ts"
  );
  const encrypted = await encryptCredentials({
    access_token: "upstream-access",
    refresh_token: "refresh",
    expires_at: Date.now() + 3600_000,
  }, config.encryptionKey);
  let finished;
  const handler = createHandler(config, async (url, init) => {
    if (String(url).endsWith("/rpc/s2a_acquire")) {
      return Response.json({
        lease_id: accountId,
        account: { ...encrypted, id: accountId, credential_version: 1 },
      });
    }
    if (String(url).endsWith("/rpc/s2a_finish")) {
      finished = JSON.parse(init.body);
      return Response.json(null);
    }
    assert.equal(
      String(url),
      "https://chatgpt.com/backend-api/codex/responses",
    );
    assert.equal(init.headers.get("authorization"), "Bearer upstream-access");
    const data =
      'data: {"type":"response.output_text.delta","delta":"hello"}\n\n' +
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":3}}}\n\n';
    const encoded = new TextEncoder().encode(data);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoded.slice(0, 71));
          controller.enqueue(encoded.slice(71));
          controller.close();
        },
      }),
      {
        headers: {
          ...(contentType ? { "content-type": contentType } : {}),
          "set-cookie": "private-cookie",
        },
      },
    );
  });
  const response = await handler(
    api("/v1/responses", "POST", { model: "test", input: "hello" }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.match(await response.text(), /response.completed/);
  assert.equal(finished.p_input_tokens, 12);
  assert.equal(finished.p_output_tokens, 3);
  assert.equal(finished.p_outcome, "completed");
});
}

test("fails over after rate limiting without forwarding account error details", async () => {
  const { encryptCredentials } = await import(
    "../supabase/functions/subscription-api/credential_store.ts"
  );
  const encrypted = await encryptCredentials({
    access_token: "token",
    refresh_token: "refresh",
  }, config.encryptionKey);
  let reservations = 0;
  const releases = [];
  const handler = createHandler(config, async (url, init) => {
    if (String(url).endsWith("/rpc/s2a_acquire")) {
      const args = JSON.parse(init.body);
      if (reservations++) {
        assert.deepEqual(args.p_excluded, [accountId]);
        assert.equal(args.p_count_request, false);
      }
      return Response.json({
        lease_id: crypto.randomUUID(),
        account: {
          ...encrypted,
          id: reservations === 1 ? accountId : groupId,
          credential_version: 1,
        },
      });
    }
    if (String(url).endsWith("/rpc/s2a_finish")) {
      releases.push(JSON.parse(init.body));
      return Response.json(null);
    }
    if (reservations === 1) {
      return Response.json({ secret: "private-upstream-account" }, {
        status: 429,
      });
    }
    return new Response(
      'data: {"type":"response.completed","response":{}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const response = await handler(
    api("/v1/responses", "POST", { model: "test", input: "hello" }),
  );
  assert.equal(response.status, 200);
  assert.equal(
    (await response.text()).includes("private-upstream-account"),
    false,
  );
  assert.equal(releases[0].p_status, 429);
  assert.equal(releases[0].p_cooldown_seconds, 60);
  assert.equal(
    releases[1].p_input_tokens,
    null,
    "missing usage is unknown, not zero",
  );
});

test("client cancellation releases its lease and is recorded as cancelled", async () => {
  const { encryptCredentials } = await import(
    "../supabase/functions/subscription-api/credential_store.ts"
  );
  const encrypted = await encryptCredentials({
    access_token: "token",
    refresh_token: "refresh",
  }, config.encryptionKey);
  let finished;
  const handler = createHandler(config, async (url, init) => {
    if (String(url).endsWith("/rpc/s2a_acquire")) {
      return Response.json({
        lease_id: accountId,
        account: { ...encrypted, id: accountId, credential_version: 1 },
      });
    }
    if (String(url).endsWith("/rpc/s2a_finish")) {
      finished = JSON.parse(init.body);
      return Response.json(null);
    }
    return new Response(new ReadableStream(), {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const response = await handler(
    api("/v1/responses", "POST", { model: "test", input: "hello" }),
  );
  await response.body.cancel();
  assert.equal(finished.p_outcome, "cancelled");
});

test("an expired account rotates once and persists the new token before forwarding", async () => {
  const { encryptCredentials, decryptCredentials } = await import(
    "../supabase/functions/subscription-api/credential_store.ts"
  );
  const encrypted = await encryptCredentials({
    access_token: "old",
    refresh_token: "old-refresh",
    expires_at: Date.now() + 1000,
  }, config.encryptionKey);
  let saved = false, refreshed = 0, privacyReads = 0, savedEncrypted;
  const handler = createHandler(config, async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/s2a_acquire")) {
      return Response.json({
        lease_id: accountId,
        account: { ...encrypted, id: accountId, credential_version: 1 },
      });
    }
    if (path.endsWith("/s2a_refresh_acquire")) return Response.json(true);
    if (path.endsWith("/oauth/token")) {
      refreshed++;
      return Response.json({
        access_token: "new",
        refresh_token: "rotated",
        expires_in: 3600,
      });
    }
    if (path.endsWith("/s2a_refresh_save")) {
      const args = JSON.parse(init.body);
      const credentials = await decryptCredentials({
        ciphertext: args.p_ciphertext,
        iv: args.p_iv,
      }, config.encryptionKey);
      assert.equal(credentials.refresh_token, "rotated");
      savedEncrypted={ciphertext:args.p_ciphertext,iv:args.p_iv};
      saved = true;
      return Response.json(true);
    }
    if (path.endsWith("/s2a_accounts")) {privacyReads++;assert.equal(saved,true);return Response.json([{id:accountId,...savedEncrypted,credential_version:2,platform:"openai",type:"oauth",extra:{privacy_mode:"training_off"}}]);}
    if (path.endsWith("/s2a_finish")) {assert.equal(JSON.parse(init.body).p_credential_version,2);return Response.json(null);}
    if (path.endsWith("/s2a_refresh_release")) return Response.json(null);
    assert.equal(saved, true);
    assert.equal(init.headers.get("authorization"), "Bearer new");
    return new Response('data: {"type":"response.completed"}\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const response = await handler(
    api("/v1/responses", "POST", { model: "test", input: "hello" }),
  );
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(refreshed, 1);
  assert.equal(privacyReads,1);
});

test("a 401 reuses another instance's rotated credentials without rotating them again", async () => {
  const { encryptCredentials } = await import(
    "../supabase/functions/subscription-api/credential_store.ts"
  );
  const old = await encryptCredentials({
    access_token: "old",
    refresh_token: "old-refresh",
  }, config.encryptionKey);
  const latest = await encryptCredentials({
    access_token: "new",
    refresh_token: "rotated",
  }, config.encryptionKey);
  let forwards = 0;
  const handler = createHandler(config, async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/s2a_acquire")) {
      return Response.json({
        lease_id: accountId,
        account: { ...old, id: accountId, credential_version: 1 },
      });
    }
    if (path.endsWith("/s2a_accounts")) {
      return Response.json([{
        ...latest,
        id: accountId,
        credential_version: 2,
      }]);
    }
    if (path.endsWith("/s2a_finish")) {assert.equal(JSON.parse(init.body).p_credential_version,2);return Response.json(null);}
    assert.equal(
      path,
      "/backend-api/codex/responses",
      "refresh endpoint must not be called",
    );
    if (forwards++ === 0) return new Response(null, { status: 401 });
    assert.equal(init.headers.get("authorization"), "Bearer new");
    return new Response('data: {"type":"response.completed"}\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const response = await handler(
    api("/v1/responses", "POST", { model: "test", input: "hello" }),
  );
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(forwards, 2);
});

test("refuses to use a rotated token that was not durably saved", async () => {
  const { encryptCredentials } = await import(
    "../supabase/functions/subscription-api/credential_store.ts"
  );
  const encrypted = await encryptCredentials({
    access_token: "old",
    refresh_token: "refresh",
    expires_at: Date.now() + 1000,
  }, config.encryptionKey);
  const handler = createHandler(config, async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/s2a_acquire")) {
      return Response.json({
        lease_id: accountId,
        account: { ...encrypted, id: accountId, credential_version: 1 },
      });
    }
    if (path.endsWith("/s2a_refresh_acquire")) return Response.json(true);
    if (path.endsWith("/oauth/token")) {
      return Response.json({ access_token: "new", refresh_token: "rotated" });
    }
    if (path.endsWith("/s2a_refresh_save")) return Response.json(false);
    if (path.endsWith("/s2a_refresh_release") || path.endsWith("/s2a_finish")) {
      return Response.json(null);
    }
    assert.fail("unpersisted token must not be forwarded");
  });
  const response = await handler(
    api("/v1/responses", "POST", { model: "test", input: "hello" }),
  );
  assert.equal(response.status, 503);
  assert.equal(
    (await response.json()).error.type,
    "credential_persistence_failed",
  );
});
