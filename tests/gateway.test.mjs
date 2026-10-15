import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptCredentials,
  encryptCredentials,
} from "../supabase/functions/sub2api/credential_store.ts";
import {
  buildHeaders,
  modelListFromManifest,
  normalizeBody,
  refreshCredentials,
  shouldRefresh,
} from "../supabase/functions/sub2api/gateway.ts";

test("encrypts persistent OAuth credentials and decrypts them losslessly", async () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const credentials = {
    access_token: "access",
    refresh_token: "refresh",
    chatgpt_account_id: "account",
  };
  const encrypted = await encryptCredentials(credentials, key);
  assert.notEqual(encrypted.ciphertext, JSON.stringify(credentials));
  assert.deepEqual(await decryptCredentials(encrypted, key), credentials);
});

test("normalizes a minimal Responses request for Codex OAuth", () => {
  const body = normalizeBody({
    model: "gpt-test",
    input: "hello",
    temperature: 0.2,
    stream: false,
  });
  assert.equal(body.model, "gpt-test");
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal("temperature" in body, false);
  assert.deepEqual(body.input, [{
    type: "message",
    role: "user",
    content: "hello",
  }]);
});

test("preserves caller instructions and tools without injecting gateway policy", () => {
  const input = {
    model: "gpt-test",
    input: "hello",
    instructions: "Only run commands in /tmp.",
    tools: [{ type: "function", name: "Bash", parameters: { type: "object" } }],
    tool_choice: "required",
  };
  const body = normalizeBody(input);
  assert.equal(body.instructions, input.instructions);
  assert.deepEqual(body.tools, input.tools);
  assert.equal(body.tool_choice, "required");
  assert.equal(input.instructions, "Only run commands in /tmp.");
  assert.equal(
    normalizeBody({
      model: "gpt-test",
      input: "hello",
      instructions: "Unchanged",
    }).instructions,
    "Unchanged",
  );
  assert.equal(
    normalizeBody({ model: "gpt-test", input: "hello", tools: [null] })
      .instructions,
    "",
  );
});

test("refreshes close-to-expiry credentials and preserves a non-rotated refresh token", async () => {
  const credentials = {
    access_token: "old-access",
    refresh_token: "old-refresh",
    client_id: "client",
    expires_at: Date.now() + 1_000,
  };
  assert.equal(shouldRefresh(credentials), true);

  const refreshed = await refreshCredentials(
    credentials,
    async (_url, init) => {
      assert.match(String(init.body), /grant_type=refresh_token/);
      return new Response(
        JSON.stringify({ access_token: "new-access", expires_in: 3600 }),
        { status: 200 },
      );
    },
  );
  assert.equal(refreshed.access_token, "new-access");
  assert.equal(refreshed.refresh_token, "old-refresh");
});

test("builds the required Codex headers", () => {
  const headers = buildHeaders({
    access_token: "secret",
    chatgpt_account_id: "account",
  });
  assert.equal(headers.get("authorization"), "Bearer secret");
  assert.equal(headers.get("chatgpt-account-id"), "account");
  assert.equal(headers.get("originator"), "codex-tui");
  assert.match(headers.get("user-agent"), /^codex-tui\//);
});

test("discovers upstream model ids without pinning versions or exposing instructions", () => {
  const result = modelListFromManifest({
    models: [
      {
        slug: "gpt-future",
        display_name: "GPT Future",
        instructions: "private",
      },
      { slug: "gpt-5.5" },
      { slug: "gpt-future" },
    ],
  });
  assert.deepEqual(result.data.map((model) => model.id), [
    "gpt-future",
    "gpt-5.5",
  ]);
  assert.equal("instructions" in result.data[0], false);
  assert.throws(() => modelListFromManifest({ error: "denied" }));
  assert.throws(() => modelListFromManifest({ models: [{}] }));
  assert.deepEqual(modelListFromManifest({ models: [] }).data, []);
});

test("rejects malformed upstream OAuth tokens before they can replace working credentials", async () => {
  for (
    const token of [
      { access_token: 123 },
      { access_token: "new", refresh_token: 123 },
      { access_token: "new", expires_in: "bad" },
      { access_token: "new", expires_in: -1 },
    ]
  ) {
    await assert.rejects(refreshCredentials(
      { access_token: "old", refresh_token: "refresh" },
      async () => Response.json(token),
    ));
  }
});
