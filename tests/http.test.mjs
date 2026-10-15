import assert from "node:assert/strict";
import test from "node:test";

import { createHandler } from "./handler.mjs";
const handler = createHandler({
  url: "https://example.supabase.co",
  serviceKey: "service",
  encryptionKey: "unused",
  adminIds: [],
}, async () => {
  throw new Error("Unexpected network call");
});

test("rejects a missing or malformed Bearer header before accessing credentials", async () => {
  for (const authorization of ["", "Basic wrong-key"]) {
    const response = await handler(
      new Request("https://example.com/v1/responses", {
        headers: { authorization },
      }),
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: { type: "unauthorized", message: "unauthorized" },
    });
  }
});

test("returns 400 for malformed or invalid request bodies without echoing secrets", async () => {
  for (const body of ["private-bad-json", "[]", "{}"]) {
    const response = await handler(
      new Request("https://example.com/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer test-gateway-key",
          "content-type": "application/json",
        },
        body,
      }),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: { type: "invalid_request", message: "invalid_request" },
    });
  }
});

test("rejects unsupported methods after authentication", async () => {
  const response = await handler(
    new Request("https://example.com", {
      method: "DELETE",
      headers: { authorization: "Bearer test-gateway-key" },
    }),
  );
  assert.equal(response.status, 404);
});

test("health routes work behind both public Supabase and Edge Runtime path prefixes", async () => {
  for (
    const prefix of ["", "/subscription-api", "/functions/v1/subscription-api"]
  ) {
    const response = await handler(
      new Request(`https://example.com${prefix}/health`),
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).scope, "subscription-gateway");
  }
});

test("native provider credentials use the same key reservation and reject conflicts", async () => {
  const seen = [];
  const native = createHandler({ url: "https://example.supabase.co", serviceKey: "service",
    encryptionKey: "unused", adminIds: [] }, async (url, init) => {
    assert.match(String(url), /\/rpc\/s2a_acquire$/);
    seen.push(JSON.parse(init.body));
    return Response.json({ status: 401, error: "invalid_api_key" });
  });
  for (const [path, headers, body] of [
    ["/v1/messages", { "x-api-key": "native-key" }, { model: "test", messages: [{ role: "user", content: "hi" }], max_tokens: 1 }],
    ["/v1beta/models/test:generateContent", { "x-goog-api-key": "native-key" }, { contents: [{ parts: [{ text: "hi" }] }] }],
    ["/v1beta/models/test:generateContent?key=native-key", {}, { contents: [{ parts: [{ text: "hi" }] }] }],
  ]) {
    const response = await native(new Request(`https://example.com${path}`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    assert.equal(response.status, 401);
  }
  assert.equal(seen.length, 3);
  assert.equal(new Set(seen.map(x => x.p_key_hash)).size, 1);
  const conflict = await native(new Request("https://example.com/v1/messages", {
    method: "POST", headers: { authorization: "Bearer other-key", "x-api-key": "native-key" },
  }));
  assert.equal(conflict.status, 400);
  assert.equal(seen.length, 3);
});
