import assert from "node:assert/strict";
import test from "node:test";
import { createBackendHandler as createHandler } from './handler.mjs';
import {
  decryptApiKeyCredentials,
  decryptCredentials,
  encryptCredentials,
} from "../supabase/functions/subscription-api/credential_store.ts";
import { parseAccountCredentials } from "../supabase/functions/subscription-api/validation.ts";
import { nativeUsage } from "../supabase/functions/subscription-api/api_key_provider.ts";
const config = {
  url: "https://project.supabase.co",
  serviceKey: "service",
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  adminIds: [],
};
async function fixture(
  platform,
  forward,
  credentials = { api_key: "provider-secret" },
) {
  const stored = await encryptCredentials(credentials, config.encryptionKey);
  const finishes = [], leases = [];
  const handler = createHandler(config, async (url, init) => {
    if (String(url).endsWith("/s2a_acquire")) {
      leases.push(JSON.parse(init.body));
      return Response.json({
        lease_id: crypto.randomUUID(),
        account: {
          ...stored,
          id: "account",
          type: "apikey",
          platform,
          credential_version: 1,
        },
      });
    }
    if (String(url).endsWith("/s2a_finish")) {
      finishes.push(JSON.parse(init.body));
      return Response.json(null);
    }
    assert.equal(
      String(url).includes("oauth"),
      false,
      "API keys never refresh OAuth tokens",
    );
    return forward(String(url), init, leases.length);
  });
  const request = (path, body, headers = {}, signal) =>
    handler(
      new Request(`https://gateway${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: "Bearer gateway-secret",
          "content-type": "application/json",
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      }),
    );
  return { request, stored, finishes, leases };
}
function sse(events) {
  const text = events.map((value) =>
    `data: ${typeof value === "string" ? value : JSON.stringify(value)}\r\n\r\n`
  ).join("");
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else controller.enqueue(bytes.slice(offset, ++offset));
      },
    }),
    {
      headers: { "content-type": "text/event-stream", "set-cookie": "private" },
    },
  );
}

test("API-key credentials encrypt losslessly, reject tampering and keep OAuth validation distinct", async () => {
  const credentials = parseAccountCredentials(
    { api_key: " secret ", base_url: "https://api.openai.com/v1/" },
    "openai",
    "apikey",
  );
  assert.deepEqual(credentials, {
    api_key: "secret",
    base_url: "https://api.openai.com",
  });
  const stored = await encryptCredentials(credentials, config.encryptionKey);
  assert.equal(stored.ciphertext.includes("secret"), false);
  assert.deepEqual(
    await decryptApiKeyCredentials(stored, config.encryptionKey),
    credentials,
  );
  await assert.rejects(decryptCredentials(stored, config.encryptionKey));
  await assert.rejects(
    decryptApiKeyCredentials({
      ...stored,
      ciphertext: stored.ciphertext.slice(0, -8),
    }, config.encryptionKey),
  );
  for (
    const [platform, type, input] of [
      ["anthropic", "oauth", {}],
      ["antigravity", "apikey", { api_key: "key" }],
      ["gemini", "apikey", {
        api_key: "key",
        base_url: "https://relay.example.com",
      }],
      ["openai", "apikey", {
        api_key: "key",
        base_url: "https://api.openai.com/evil",
      }],
      ["openai", "apikey", {
        api_key: "key",
        model_mapping: { anything: "restricted" },
      }],
    ]
  ) {
    assert.throws(
      () => parseAccountCredentials(input, platform, type),
      (error) => error.status === 501,
    );
  }
  assert.throws(
    () =>
      parseAccountCredentials({ api_key: "bad\nheader" }, "openai", "apikey"),
    (error) => error.status === 400,
  );
  assert.deepEqual(
    parseAccountCredentials(
      { api_key: "key", tier_id: "aistudio_free", model_mapping: {} },
      "gemini",
      "apikey",
    ),
    { api_key: "key" },
  );
});

for (
  const [path, body, result] of [
    ["/v1/chat/completions", {
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.6,
      max_completion_tokens: 10,
    }, {
      object: "chat.completion",
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: "hi" },
      }],
      usage: { prompt_tokens: 8, completion_tokens: 2 },
    }],
    ["/v1/responses", {
      model: "gpt-test",
      input: "hi",
      stream: false,
      temperature: 0.6,
      max_output_tokens: 10,
    }, {
      object: "response",
      status: "completed",
      output: [],
      usage: { input_tokens: 8, output_tokens: 2 },
    }],
  ]
) {
  test(`OpenAI API-key ${path} forwards native JSON unchanged and accounts usage`, async () => {
    const value = await fixture("openai", (url, init) => {
      assert.equal(url, `https://api.openai.com${path}`);
      assert.equal(init.headers.get("authorization"), "Bearer provider-secret");
      assert.equal(init.headers.get("chatgpt-account-id"), null);
      assert.equal(init.redirect, "error");
      assert.deepEqual(JSON.parse(init.body), body);
      return Response.json(result, { headers: { "set-cookie": "private" } });
    });
    const response = await value.request(path, body);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), result);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(value.finishes.length, 1);
    assert.equal(value.finishes[0].p_input_tokens, 8);
    assert.equal(value.finishes[0].p_output_tokens, 2);
    assert.equal(value.finishes[0].p_outcome, "completed");
  });
}

test("Anthropic JSON uses the encrypted upstream key, version and beta, including cached input usage", async () => {
  const body = {
    model: "claude-test",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 100,
  };
  const result = {
    type: "message",
    content: [{ type: "text", text: "hi" }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 3,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 2,
      output_tokens: 5,
    },
  };
  const value = await fixture("anthropic", (url, init) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal(init.headers.get("x-api-key"), "provider-secret");
    assert.equal(init.headers.get("authorization"), null);
    assert.equal(init.headers.get("anthropic-version"), "2023-06-01");
    assert.equal(
      init.headers.get("anthropic-beta"),
      "prompt-caching-2024-07-31",
    );
    assert.deepEqual(JSON.parse(init.body), body);
    return Response.json(result);
  });
  assert.deepEqual(
    await (await value.request("/v1/messages", body, {
      "x-api-key": "gateway-secret",
      "anthropic-beta": "prompt-caching-2024-07-31",
    })).json(),
    result,
  );
  assert.equal(value.finishes[0].p_input_tokens, 9);
  assert.equal(value.finishes[0].p_output_tokens, 5);
});

test("Gemini generation preserves native JSON and uses header auth without leaking query keys", async () => {
  const body = {
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    generationConfig: { maxOutputTokens: 20 },
  };
  const result = {
    candidates: [{
      finishReason: "STOP",
      content: { parts: [{ text: "hi" }] },
    }],
    usageMetadata: {
      promptTokenCount: 6,
      candidatesTokenCount: 3,
      thoughtsTokenCount: 2,
    },
  };
  const value = await fixture("gemini", (url, init) => {
    assert.equal(
      url,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent",
    );
    assert.equal(init.headers.get("x-goog-api-key"), "provider-secret");
    assert.deepEqual(JSON.parse(init.body), body);
    return Response.json(result);
  });
  const response = await value.request(
    "/v1beta/models/gemini-test:generateContent?key=gateway-secret",
    body,
  );
  assert.deepEqual(await response.json(), result);
  assert.equal(value.leases[0].p_model, "gemini-test");
  assert.equal(value.finishes[0].p_input_tokens, 6);
  assert.equal(value.finishes[0].p_output_tokens, 5);
});

for (
  const [platform, path, body, events, input, output] of [
    [
      "openai",
      "/v1/chat/completions",
      {
        model: "gpt-test",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        stream_options: { include_usage: true },
      },
      [
        { choices: [{ delta: { content: "你好" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } },
        "[DONE]",
      ],
      7,
      2,
    ],
    [
      "openai",
      "/v1/responses",
      { model: "gpt-test", input: "hi", stream: true },
      [{ type: "response.output_text.delta", delta: "你好" }, {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 7, output_tokens: 2 },
        },
      }],
      7,
      2,
    ],
    [
      "anthropic",
      "/v1/messages",
      {
        model: "claude-test",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
        stream: true,
      },
      [{
        type: "message_start",
        message: {
          usage: {
            input_tokens: 4,
            cache_read_input_tokens: 3,
            output_tokens: 0,
          },
        },
      }, {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "你好" },
      }, {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 2 },
      }, { type: "message_stop" }],
      7,
      2,
    ],
    [
      "gemini",
      "/v1beta/models/gemini-test:streamGenerateContent",
      { contents: [{ parts: [{ text: "hi" }] }] },
      [{ candidates: [{ content: { parts: [{ text: "你好" }] } }] }, {
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 },
      }],
      7,
      2,
    ],
  ]
) {
  test(`${platform} native SSE preserves fragmented UTF8 and accounts final usage`, async () => {
    const value = await fixture(platform, (url) => {
      if (platform === "gemini") assert.equal(new URL(url).search, "?alt=sse");
      return sse(events);
    });
    const response = await value.request(path, body);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /你好/);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(value.finishes.length, 1);
    assert.equal(value.finishes[0].p_input_tokens, input);
    assert.equal(value.finishes[0].p_output_tokens, output);
    assert.equal(value.finishes[0].p_outcome, "completed");
  });
}

test("missing or invalid native token counts remain unknown instead of invented zero", async () => {
  const value = await fixture(
    "openai",
    () =>
      Response.json({
        object: "chat.completion",
        choices: [{ finish_reason: "stop" }],
        usage: { prompt_tokens: -1, completion_tokens: "2" },
      }),
  );
  await (await value.request("/v1/chat/completions", {
    model: "test",
    messages: [{ role: "user", content: "hi" }],
  })).json();
  assert.equal(value.finishes[0].p_input_tokens, null);
  assert.equal(value.finishes[0].p_output_tokens, null);
  assert.equal(value.finishes[0].p_outcome, "completed");
  const absent = await fixture(
    "openai",
    () => sse([{ choices: [{ finish_reason: "stop" }] }, "[DONE]"]),
  );
  await (await absent.request("/v1/chat/completions", {
    model: "test",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  })).text();
  assert.equal(absent.finishes[0].p_input_tokens, null);
  assert.equal(absent.finishes[0].p_output_tokens, null);
});

test("mismatched protocols and decrypted custom origins fail explicitly before provider fetch", async () => {
  for (
    const [platform, path, body, credentials] of [
      ["anthropic", "/v1/chat/completions", {
        model: "test",
        messages: [{ role: "user", content: "hi" }],
      }, { api_key: "secret" }],
      ["gemini", "/v1/messages", {
        model: "test",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10,
      }, { api_key: "secret" }],
      ["openai", "/v1/responses", { model: "test", input: "hi" }, {
        api_key: "secret",
        base_url: "https://hostile.example",
      }],
    ]
  ) {
    const value = await fixture(
      platform,
      () => assert.fail("must never send credentials to provider"),
      credentials,
    );
    assert.equal((await value.request(path, body)).status, 501);
    assert.equal(value.finishes.length, 1);
  }
});

test("native cancellation releases its lease; provider stream errors are sanitized and fail once", async () => {
  let cancelled = false;
  const value = await fixture(
    "anthropic",
    () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const response = await value.request("/v1/messages", {
    model: "test",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 10,
    stream: true,
  });
  await response.body.cancel();
  assert.equal(cancelled, true);
  assert.equal(value.finishes.length, 1);
  assert.equal(value.finishes[0].p_outcome, "cancelled");
  const failure = await fixture(
    "anthropic",
    () =>
      sse([{ type: "error", error: { message: "private provider secret" } }]),
  );
  const failed = await failure.request("/v1/messages", {
    model: "test",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 10,
    stream: true,
  });
  await assert.rejects(failed.text(), /upstream_stream_failed/);
  assert.equal(failure.finishes.length, 1);
  assert.equal(failure.finishes[0].p_outcome, "failed");
});

test("API-key 401 fails over without any token refresh or provider error leakage", async () => {
  const value = await fixture(
    "openai",
    (_url, _init, attempt) =>
      attempt === 1
        ? Response.json({ error: "private provider secret" }, { status: 401 })
        : Response.json({
          object: "chat.completion",
          choices: [{ finish_reason: "stop" }],
        }),
  );
  const response = await value.request("/v1/chat/completions", {
    model: "test",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(response.status, 200);
  assert.equal((await response.text()).includes("private provider"), false);
  assert.equal(value.leases.length, 2);
  assert.deepEqual(value.leases[1].p_excluded, ["account"]);
  assert.equal(value.leases[1].p_count_request, false);
  assert.equal(value.finishes.length, 2);
});

test("provider usage handles incomplete terminal events without fabricating costs", () => {
  assert.equal(
    nativeUsage("anthropic", "messages", { stop_reason: "max_tokens" }).outcome,
    "incomplete",
  );
  assert.equal(
    nativeUsage("gemini", "gemini", {
      candidates: [{ finishReason: "MAX_TOKENS" }],
    }).outcome,
    "incomplete",
  );
  assert.equal(
    nativeUsage("openai", "chat", { choices: [{ finish_reason: "length" }] })
      .outcome,
    "incomplete",
  );
});

test("provider usage preserves cache token fields", () => {
  assert.deepEqual(
    nativeUsage("openai", "chat", {
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 80 },
      },
      choices: [{ finish_reason: "stop" }],
    }),
    {
      input: 120,
      output: 30,
      cacheCreation: null,
      cacheRead: 80,
      outcome: "completed",
    },
  );
  assert.equal(nativeUsage("openai", "responses", {
    usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 70 } },
  }).cacheRead, 70);
  assert.deepEqual(
    nativeUsage("anthropic", "messages", {
      type: "message",
      usage: {
        input_tokens: 20,
        output_tokens: 5,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 4,
      },
      stop_reason: "end_turn",
    }),
    {
      input: 34,
      output: 5,
      cacheCreation: 4,
      cacheRead: 10,
      outcome: "completed",
    },
  );
});

test("fragmented SSE provider errors never reach the client even before the frame ends", async () => {
  const value = await fixture(
    "anthropic",
    () =>
      sse([{ type: "content_block_delta", delta: { text: "safe text" } }, {
        type: "error",
        error: { message: "private provider secret" },
      }]),
  );
  const response = await value.request("/v1/messages", {
    model: "test",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 10,
    stream: true,
  });
  const reader = response.body.getReader();
  let received = "";
  await assert.rejects(async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += new TextDecoder().decode(value);
    }
  }, /upstream_stream_failed/);
  assert.match(received, /safe text/);
  assert.equal(received.includes("private provider secret"), false);
  assert.equal(value.finishes[0].p_outcome, "failed");
});

for (const platform of ["openai", "anthropic", "gemini"]) {
  test(`${platform} API-key model list/get uses the real provider catalog and releases one lease`, async () => {
    const origins = {
      openai: "https://api.openai.com",
      anthropic: "https://api.anthropic.com",
      gemini: "https://generativelanguage.googleapis.com",
    };
    const list = platform === "gemini"
      ? {
        models: [{
          name: "models/gemini-test",
          inputTokenLimit: 1000,
          supportedGenerationMethods: ["generateContent"],
        }],
        nextPageToken: "next",
      }
      : {
        data: [{
          id: "model-test",
          ...(platform === "anthropic"
            ? {
              type: "model",
              display_name: "Model",
              created_at: "2026-01-01T00:00:00Z",
            }
            : { object: "model", created: 100, owned_by: "openai" }),
        }],
        ...(platform === "anthropic"
          ? { has_more: false, first_id: "model-test", last_id: "model-test" }
          : { object: "list" }),
      };
    const value = await fixture(platform, (url, init) => {
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      const providerPath = platform === "gemini"
        ? "/v1beta/models"
        : "/v1/models";
      assert.ok(url.startsWith(origins[platform] + providerPath));
      if (platform === "openai") {
        assert.equal(
          init.headers.get("authorization"),
          "Bearer provider-secret",
        );
      }
      if (platform === "anthropic") {
        assert.equal(init.headers.get("x-api-key"), "provider-secret");
        assert.equal(init.headers.get("anthropic-version"), "2023-06-01");
      }
      if (platform === "gemini") {
        assert.equal(init.headers.get("x-goog-api-key"), "provider-secret");
      }
      assert.equal(init.body, undefined);
      return Response.json(
        url.endsWith("/models")
          ? list
          : platform === "gemini"
          ? list.models[0]
          : list.data[0],
      );
    });
    const response = await value.request("/v1/models");
    assert.equal(response.status, 200);
    const result = await response.json();
    if (platform === "gemini") {
      assert.equal(result.data[0].id, "gemini-test");
      assert.equal(result.data[0].inputTokenLimit, 1000);
      assert.equal(result.nextPageToken, "next");
    } else assert.deepEqual(result, list);
    assert.equal(value.finishes.length, 1);
    assert.equal(value.finishes[0].p_outcome, "completed");
    assert.equal(value.finishes[0].p_input_tokens, null);
    assert.equal(value.leases[0].p_model, "__models__");
    const single = await value.request(
      `/v1/models/${platform === "gemini" ? "gemini-test" : "model-test"}`,
    );
    assert.equal(single.status, 200);
    assert.equal(
      (await single.json()).id,
      platform === "gemini" ? "gemini-test" : "model-test",
    );
    assert.equal(value.finishes.length, 2);
  });
}

test("Gemini native model list/get retains pagination and capabilities without forwarding client keys", async () => {
  const model = {
    name: "models/gemini-test",
    inputTokenLimit: 100,
    outputTokenLimit: 20,
    supportedGenerationMethods: ["generateContent"],
  };
  const list = { models: [model], nextPageToken: "next-token" };
  const value = await fixture("gemini", (url, init) => {
    const target = new URL(url);
    assert.equal(target.origin, "https://generativelanguage.googleapis.com");
    assert.equal(target.searchParams.get("key"), null);
    assert.equal(init.headers.get("x-goog-api-key"), "provider-secret");
    if (target.pathname.endsWith("/gemini-test")) return Response.json(model);
    assert.equal(target.searchParams.get("pageSize"), "10");
    assert.equal(target.searchParams.get("pageToken"), "cursor/+a");
    return Response.json(list);
  });
  const response = await value.request(
    "/v1beta/models?pageSize=10&pageToken=cursor%2F%2Ba",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), list);
  assert.deepEqual(
    await (await value.request("/v1beta/models/gemini-test")).json(),
    model,
  );
  assert.equal(value.finishes.length, 2);
});

test("Anthropic model pagination is forwarded with native version and beta headers", async () => {
  const value = await fixture("anthropic", (url, init) => {
    assert.equal(
      url,
      "https://api.anthropic.com/v1/models?after_id=claude-test&limit=10",
    );
    assert.equal(init.headers.get("anthropic-version"), "2023-06-01");
    assert.equal(init.headers.get("anthropic-beta"), "models-beta");
    return Response.json({ data: [], has_more: false });
  });
  const response = await value.request(
    "/v1/models?after_id=claude-test&limit=10",
    undefined,
    { "anthropic-beta": "models-beta" },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: [], has_more: false });
  assert.equal(value.finishes.length, 1);
});

test("model catalog errors, invalid pagination and incompatible native routes release leases honestly", async () => {
  let fetches = 0;
  const invalid = await fixture("gemini", () => {
    fetches++;
    return Response.json({ models: [{ name: "secret" }] });
  });
  const malformed = await invalid.request("/v1beta/models");
  assert.equal(malformed.status, 502);
  assert.equal((await malformed.text()).includes("secret"), false);
  assert.equal(invalid.finishes.length, 1);
  assert.equal(
    (await invalid.request("/v1beta/models?pageSize=1001")).status,
    400,
  );
  assert.equal(fetches, 1);
  assert.equal(invalid.finishes.length, 2);
  const wrong = await fixture("openai", () => {
    throw new Error("must not forward");
  });
  assert.equal((await wrong.request("/v1beta/models")).status, 501);
  assert.equal(wrong.finishes.length, 1);
  const absent = await fixture(
    "anthropic",
    () =>
      Response.json({ error: { message: "private provider details" } }, {
        status: 404,
      }),
  );
  const response = await absent.request("/v1/models/missing");
  assert.equal(response.status, 404);
  assert.equal((await response.text()).includes("private"), false);
  assert.equal(absent.finishes.length, 1);
});

test('gateway captures service tier and native stream mode for database billing', async () => {
  const value=await fixture('openai',()=>Response.json({id:'chat',choices:[],usage:{prompt_tokens:100,completion_tokens:10,prompt_tokens_details:{cached_tokens:20}}}));
  const response=await value.request('/v1/chat/completions',{model:'gpt-4.1',messages:[{role:'user',content:'Hello'}],service_tier:'priority',stream:false});
  assert.equal(response.status,200);await response.json();
  assert.deepEqual(value.leases[0].p_billing_context,{policy_model:'gpt-4.1',model_candidates:['gpt-4.1'],service_tier:'priority',stream:false,native_stream:false});
  assert.equal(value.finishes[0].p_input_tokens,100);assert.equal(value.finishes[0].p_cache_read_tokens,20);
});

test('a transient settlement failure retries identical usage without another provider request', async () => {
  const stored=await encryptCredentials({api_key:'provider-secret'},config.encryptionKey);
  const settlements=[];let forwards=0;
  const handler=createHandler(config,async(url,init)=>{
    if(String(url).endsWith('/s2a_acquire'))return Response.json({lease_id:'lease',account:{...stored,id:'account',type:'apikey',platform:'openai',credential_version:1}});
    if(String(url).endsWith('/s2a_finish')){
      settlements.push(JSON.parse(init.body));return settlements.length===1?Response.json({},{status:503}):Response.json(null);
    }
    forwards++;return Response.json({id:'response',object:'response',status:'completed',output:[],usage:{input_tokens:100,output_tokens:10,input_tokens_details:{cached_tokens:20}}});
  });
  const response=await handler(new Request('https://gateway/v1/responses',{method:'POST',headers:{authorization:'Bearer gateway-secret','content-type':'application/json'},body:JSON.stringify({model:'gpt-4.1',input:'Hello',stream:false})}));
  assert.equal(response.status,200);await response.json();
  assert.equal(forwards,1);assert.equal(settlements.length,2);assert.deepEqual(settlements[0],settlements[1]);
  assert.equal(settlements[1].p_cache_read_tokens,20);
});

for (const stream of [false, true]) test(`OpenAI API-key Messages bridge preserves tools, limits and usage (stream=${stream})`, async () => {
  const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'weather', arguments: '{"city":"Shanghai"}' };
  const completed = { object: 'response', model: 'gpt-test', status: 'completed', output: [call], usage: { input_tokens: 12, output_tokens: 4, input_tokens_details: { cached_tokens: 3 } } };
  const value = await fixture('openai', (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init.headers.get('authorization'), 'Bearer provider-secret');
    const outgoing = JSON.parse(init.body);
    assert.equal(outgoing.stream, true);
    assert.equal(outgoing.store, false);
    assert.equal(outgoing.max_output_tokens, 100);
    assert.equal(outgoing.temperature, 0.5);
    assert.equal(outgoing.reasoning, undefined);
    assert.equal(outgoing.tools[0].name, 'weather');
    assert.equal(outgoing.tool_choice, 'required');
    assert.equal(outgoing.input[0].role, 'developer');
    return sse([
      { type: 'response.created', response: { model: 'gpt-test' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: call.arguments },
      { type: 'response.output_item.done', output_index: 0, item: call },
      { type: 'response.completed', response: completed },
    ]);
  });
  const response = await value.request('/v1/messages', { model: 'gpt-test', max_tokens: 100, temperature: 0.5, stream, system: 'Be helpful.', messages: [{ role: 'user', content: 'Weather?' }], tools: [{ name: 'weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }], tool_choice: { type: 'any' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  if (stream) {
    const text = await response.text();
    assert.match(text, /event: message_stop/);
    assert.match(text, /"type":"tool_use"/);
    assert.match(text, /"stop_reason":"tool_use"/);
    assert.match(text, /Shanghai/);
  } else {
    const result = await response.json();
    assert.equal(result.type, 'message');
    assert.equal(result.stop_reason, 'tool_use');
    assert.deepEqual(result.content[0], { type: 'tool_use', id: 'call_1', name: 'weather', input: { city: 'Shanghai' } });
    assert.equal(result.usage.cache_read_input_tokens, 3);
  }
  assert.equal(value.finishes.length, 1);
  assert.equal(value.finishes[0].p_input_tokens, 12);
  assert.equal(value.finishes[0].p_output_tokens, 4);
  assert.equal(value.finishes[0].p_outcome, 'completed');
});

test('OpenAI API-key Messages bridge rejects invalid requests before dispatch and records truncated streams', async () => {
  let dispatched = 0;
  const value = await fixture('openai', () => { dispatched++; return sse([{ type: 'response.output_text.delta', delta: 'partial' }]); });
  const body = { model: 'gpt-test', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] };
  assert.equal((await value.request('/v1/messages', { ...body, temperature: 9 })).status, 400);
  assert.equal(dispatched, 0);
  assert.equal((await value.request('/v1/messages', body)).status, 502);
  assert.equal(value.finishes.at(-1).p_outcome, 'incomplete');
});
