import assert from "node:assert/strict";
import test from "node:test";
import {
  chatToResponses,
  completedResponse,
  responseToChat,
  streamChat,
} from "../supabase/functions/sub2api/openai_protocol.ts";
import { createBackendHandler as createHandler } from './handler.mjs';
import { encryptCredentials } from "../supabase/functions/sub2api/credential_store.ts";

const config = {
  url: "https://project.supabase.co",
  serviceKey: "service",
  encryptionKey: Buffer.alloc(32, 7).toString("base64"),
  adminIds: [],
};
const complete = {
  id: "resp-test",
  object: "response",
  model: "gpt-test",
  status: "completed",
  created_at: 123,
  output: [{
    type: "message",
    content: [{ type: "output_text", text: "你好" }],
  }, {
    type: "function_call",
    call_id: "call-1",
    name: "lookup",
    arguments: '{"q":"你好"}',
  }],
  usage: {
    input_tokens: 12,
    output_tokens: 3,
    total_tokens: 15,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 1 },
  },
};
const events = [
  { type: "response.created", response: { model: "gpt-test" } },
  {
    type: "response.output_item.added",
    output_index: 1,
    item: {
      type: "function_call",
      call_id: "call-1",
      name: "lookup",
      arguments: "",
    },
  },
  {
    type: "response.function_call_arguments.delta",
    output_index: 1,
    delta: '{"q":"你好"}',
  },
  { type: "response.output_text.delta", delta: "你好" },
  { type: "response.completed", response: complete },
];
function source(values = events) {
  const bytes = new TextEncoder().encode(
    values.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""),
  );
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) controller.close();
      else controller.enqueue(bytes.slice(offset, ++offset));
    },
  });
}
async function fixture(upstream) {
  const encrypted = await encryptCredentials({
    access_token: "private-token",
    refresh_token: "refresh",
    expires_at: Date.now() + 3600000,
  }, config.encryptionKey);
  const leases = [], finishes = [];
  const handler = createHandler(config, async (url, init) => {
    if (String(url).endsWith("/s2a_acquire")) {
      leases.push(JSON.parse(init.body));
      return Response.json({
        lease_id: "lease",
        account: { ...encrypted, id: "account", credential_version: 1 },
      });
    }
    if (String(url).endsWith("/s2a_finish")) {
      finishes.push(JSON.parse(init.body));
      return Response.json(null);
    }
    assert.equal(init.headers.get("authorization"), "Bearer private-token");
    return upstream(url, init);
  });
  const request = (path, body, signal) =>
    handler(
      new Request(`https://gateway${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: "Bearer api-key",
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      }),
    );
  return { request, leases, finishes };
}

test("chat conversion preserves text instructions, tool call history and structured outputs", () => {
  const input = {
    model: "gpt-test",
    messages: [
      { role: "system", content: [{ type: "text", text: "policy" }] },
      { role: "user", content: "find" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call",
          type: "function",
          function: { name: "lookup", arguments: "{}" },
        }],
      },
      { role: "tool", tool_call_id: "call", content: "answer" },
    ],
    tools: [{
      type: "function",
      function: {
        name: "lookup",
        parameters: { type: "object" },
        strict: true,
      },
    }],
    tool_choice: { type: "function", function: { name: "lookup" } },
    reasoning_effort: "high",
    parallel_tool_calls: false,
    response_format: {
      type: "json_schema",
      json_schema: { name: "answer", schema: { type: "object" }, strict: true },
    },
  };
  const converted = chatToResponses(input);
  assert.equal(converted.instructions, "policy");
  assert.deepEqual(converted.input.slice(1), [{
    type: "function_call",
    call_id: "call",
    name: "lookup",
    arguments: "{}",
  }, { type: "function_call_output", call_id: "call", output: "answer" }]);
  assert.deepEqual(converted.tool_choice, { type: "function", name: "lookup" });
  assert.equal(converted.text.format.strict, true);
  assert.equal(converted.tools[0].strict, true);
  assert.equal(converted.parallel_tool_calls, false);
  assert.throws(() =>
    chatToResponses({
      messages: [{ role: "user", content: [{ type: "image_url" }] }],
    })
  );
  assert.throws(() =>
    chatToResponses({ messages: [{ role: "tool", content: "bad" }] })
  );
});

test("incremental SSE parser preserves fragmented UTF8 and terminal JSON", async () => {
  assert.deepEqual(await completedResponse(source()), complete);
  const chat = responseToChat(complete, "chatcmpl-test");
  assert.equal(chat.choices[0].message.content, "你好");
  assert.equal(
    chat.choices[0].message.tool_calls[0].function.arguments,
    '{"q":"你好"}',
  );
  assert.equal(chat.choices[0].finish_reason, "tool_calls");
  assert.equal(chat.usage.prompt_tokens_details.cached_tokens, 2);
  assert.equal(
    responseToChat({
      ...complete,
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    }, "test").choices[0].finish_reason,
    "length",
  );
  await assert.rejects(
    completedResponse(source(events.slice(0, -1))),
    /without completion/,
  );
});

test("chat streams text and tool deltas, finish reason, optional usage and DONE", async () => {
  const text = await new Response(
    streamChat(source(), "chatcmpl-test", "gpt-test", true),
  ).text();
  const chunks = text.split(/\n\n/).filter(Boolean).map((line) =>
    line.slice(6)
  );
  assert.equal(chunks.pop(), "[DONE]");
  const records = chunks.map(JSON.parse);
  assert.equal(records[0].choices[0].delta.role, "assistant");
  assert.equal(records[1].choices[0].delta.tool_calls[0].index, 0);
  assert.equal(
    records[2].choices[0].delta.tool_calls[0].function.arguments,
    '{"q":"你好"}',
  );
  assert.equal(records[3].choices[0].delta.content, "你好");
  assert.equal(records[4].choices[0].finish_reason, "tool_calls");
  assert.deepEqual(records[5].choices, []);
  assert.equal(records[5].usage.total_tokens, 15);
});

for (
  const [path, body] of [
    ["/v1/chat/completions", {
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
    }],
    ["/v1/chat/completions", {
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    }],
    ["/v1/responses", { model: "gpt-test", input: "hi", stream: false }],
    ["/v1/messages", {
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
    }],
    ["/v1/messages", {
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
      stream: true,
    }],
  ]
) {
  test(`${path} stream=${body.stream} records the upstream usage once`, async () => {
    const fixtureValue = await fixture((_url, init) => {
      const forwarded = JSON.parse(init.body);
      assert.equal(forwarded.stream, true);
      assert.equal(forwarded.store, false);
      assert.equal(forwarded.messages, undefined);
      return new Response(source(), {
        headers: {
          "content-type": "text/event-stream",
          "set-cookie": "private",
        },
      });
    });
    const response = await fixtureValue.request(path, body);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), null);
    if (body.stream) {
      assert.match(
        await response.text(),
        path.includes("messages") ? /event: message_stop/ : /\[DONE\]/,
      );
    } else if (path.includes("messages")) {
      assert.equal((await response.json()).type, "message");
    } else {assert.equal(
        (await response.json()).object,
        path.includes("chat") ? "chat.completion" : "response",
      );}
    assert.equal(fixtureValue.finishes.length, 1);
    assert.equal(fixtureValue.finishes[0].p_outcome, "completed");
    assert.equal(fixtureValue.finishes[0].p_input_tokens, 12);
    assert.equal(fixtureValue.finishes[0].p_output_tokens, 3);
    assert.equal(fixtureValue.leases[0].p_model, "gpt-test");
  });
}

test("chat cancellation interrupts a pending upstream read and releases its lease once", async () => {
  let cancelled = false;
  const value = await fixture(() =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  );
  const response = await value.request("/v1/chat/completions", {
    model: "test",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  });
  await response.body.cancel();
  assert.equal(cancelled, true);
  assert.equal(value.finishes.length, 1);
  assert.equal(value.finishes[0].p_outcome, "cancelled");
});

test("models supports Codex manifests, version forwarding and individual OpenAI lookup", async () => {
  const manifest = {
    models: [{
      slug: "gpt-test",
      instructions: "Model instructions",
      context_window: 200000,
    }],
    private_account_metadata: "secret",
  };
  let version;
  const value = await fixture((url) => {
    version = new URL(url).searchParams.get("client_version");
    return Response.json(manifest);
  });
  const codex = await value.request("/v1/models?client_version=0.145.0");
  assert.deepEqual(await codex.json(), { models: manifest.models });
  assert.equal(version, "0.145.0");
  const ordinary = await value.request("/v1/models");
  assert.equal((await ordinary.json()).data[0].instructions, undefined);
  assert.equal(
    (await (await value.request("/v1/models/gpt-test")).json()).id,
    "gpt-test",
  );
  assert.equal((await value.request("/v1/models/missing")).status, 404);
});

test("new routes still require API-key reservation authorization and reject invalid bodies before forwarding", async () => {
  const handler = createHandler(
    config,
    async () => Response.json({ error: "invalid_api_key", status: 401 }),
  );
  const request = (body) =>
    new Request("https://gateway/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer bad" },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await handler(
      request({ model: "test", messages: [{ role: "user", content: "hi" }] }),
    )).status,
    401,
  );
  assert.equal(
    (await handler(request({ model: "test", messages: [] }))).status,
    400,
  );
  assert.equal(
    (await handler(
      request({
        model: "test",
        messages: [{ role: "user", content: "hi" }],
        stream: "true",
      }),
    )).status,
    400,
  );
  assert.equal(
    (await handler(new Request("https://gateway/v1/models/gpt-test"))).status,
    401,
  );
});

test("upstream failed and incomplete events preserve lease outcomes without leaking error details", async () => {
  for (const outcome of ["failed", "incomplete"]) {
    const response = {
      ...complete,
      status: outcome,
      incomplete_details: { reason: "max_output_tokens" },
      error: { message: "private account secret" },
    };
    const value = await fixture(() =>
      new Response(source([{ type: `response.${outcome}`, response }]), {
        headers: { "content-type": "text/event-stream" },
      })
    );
    const result = await value.request("/v1/chat/completions", {
      model: "test",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const text = await result.text();
    assert.equal(text.includes("private account secret"), false);
    if (outcome === "incomplete") {
      assert.match(text, /"finish_reason":"length"/);
    } else assert.match(text, /upstream_error/);
    assert.equal(value.finishes.length, 1);
    assert.equal(value.finishes[0].p_outcome, outcome);
    assert.equal(value.finishes[0].p_input_tokens, 12);
  }
});

test("request abort cancels a streaming chat read and releases the account lease", async () => {
  let cancelled = false;
  const value = await fixture(() =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  );
  const abort = new AbortController();
  const response = await value.request("/v1/chat/completions", {
    model: "test",
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  }, abort.signal);
  abort.abort();
  await response.text();
  assert.equal(cancelled, true);
  assert.equal(value.finishes.length, 1);
  assert.equal(value.finishes[0].p_outcome, "cancelled");
});

test("a rejected upstream request releases a lease only once and hides provider error bodies", async () => {
  const value = await fixture(() =>
    Response.json({ error: "private provider account details" }, {
      status: 400,
    })
  );
  const response = await value.request("/v1/chat/completions", {
    model: "test",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(response.status, 400);
  assert.equal((await response.text()).includes("private provider"), false);
  assert.equal(value.finishes.length, 1);
  assert.equal(value.finishes[0].p_status, 400);
  assert.equal(value.finishes[0].p_outcome, "failed");
});

test("chat images retain URL and detail; tool-result images become visible user input", () => {
  const image = {
    type: "image_url",
    image_url: { url: "data:image/png;base64,YQ==", detail: "high" },
  };
  const result = chatToResponses({
    model: "test",
    messages: [
      { role: "user", content: [{ type: "text", text: "describe" }, image] },
      {
        role: "tool",
        tool_call_id: "call",
        content: [{ type: "text", text: "screenshot" }, image],
      },
    ],
  });
  assert.deepEqual(result.input[0].content[1], {
    type: "input_image",
    image_url: image.image_url.url,
    detail: "high",
  });
  assert.equal(result.input[1].output, "screenshot");
  assert.equal(result.input[2].content[0].type, "input_image");
  assert.throws(() =>
    chatToResponses({
      messages: [{
        role: "user",
        content: [{ ...image, image_url: { url: "" } }],
      }],
    })
  );
  assert.throws(() =>
    chatToResponses({ messages: [{ role: "system", content: [image] }] })
  );
});

test("legacy functions pair calls deterministically and retain tool schema fields", () => {
  const body = {
    model: "test",
    messages: [
      { role: "assistant", function_call: { name: "lookup", arguments: "{}" } },
      { role: "function", name: "lookup", content: "answer" },
    ],
    functions: [{
      name: "lookup",
      description: "Search",
      parameters: { type: "object" },
      strict: true,
    }],
    function_call: { name: "lookup" },
  };
  const result = chatToResponses(body);
  assert.equal(result.input[0].call_id, result.input[1].call_id);
  assert.equal(result.tools[0].description, "Search");
  assert.equal(result.tools[0].strict, true);
  assert.deepEqual(result.tool_choice, { type: "function", name: "lookup" });
  assert.equal(body.messages[1].role, "function");
});

test("terminal-only Chat output still streams text and function calls", async () => {
  const text = await new Response(
    streamChat(
      source([{ type: "response.completed", response: complete }]),
      "id",
      "test",
    ),
  ).text();
  assert.match(text, /"content":"你好"/);
  assert.match(text, /"name":"lookup"/);
  assert.match(text, /\[DONE\]/);
});

test("Messages request abort releases the OAuth account lease once", async () => {
  let cancelled = false;
  const value = await fixture(() =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  );
  const abort = new AbortController();
  const response = await value.request("/v1/messages", {
    model: "test",
    max_tokens: 10,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  }, abort.signal);
  abort.abort();
  await response.text();
  assert.equal(cancelled, true);
  assert.equal(value.finishes.length, 1);
  assert.equal(value.finishes[0].p_outcome, "cancelled");
});

test('upstream root aliases preserve model lookup, Codex metadata, chat output and usage', async () => {
  const manifest={models:[{slug:'gpt-test',instructions:'Provider instructions',context_window:200000}]};
  const catalog=await fixture(()=>Response.json(manifest));
  for(const prefix of ['', '/sub2api', '/functions/v1/sub2api']) {
    const models=await catalog.request(prefix+'/models');
    assert.equal(models.status,200);assert.equal((await models.json()).data[0].id,'gpt-test');
    const model=await catalog.request(prefix+'/models/gpt-test');
    assert.equal(model.status,200);assert.equal((await model.json()).id,'gpt-test');
    const codex=await catalog.request(prefix+'/models?client_version=0.162.1');
    assert.equal(codex.status,200);assert.deepEqual((await codex.json()).models,manifest.models);
    const chat=await fixture(()=>new Response(source(),{headers:{'content-type':'text/event-stream'}}));
    const response=await chat.request(prefix+'/chat/completions',{model:'gpt-test',messages:[{role:'user',content:'hello'}],stream:false});
    assert.equal(response.status,200);assert.ok((await response.json()).choices[0].message.content);
    assert.equal(chat.leases.length,1);assert.equal(chat.finishes.length,1);
    assert.equal(chat.finishes[0].p_input_tokens,complete.usage.input_tokens);
  }
});
test('root aliases keep authentication, credential conflicts and unknown-route boundaries',async()=>{
  let called=0;const handler=createHandler(config,async()=>{called++;throw Error('Unexpected provider access');});
  for(const path of ['/models','/models/gpt-test','/chat/completions']){
    const denied=await handler(new Request('https://gateway'+path));assert.equal(denied.status,401);
  }
  const conflict=await handler(new Request('https://gateway/models',{headers:{authorization:'Bearer one','x-api-key':'two'}}));
  assert.equal(conflict.status,400);
  const invalid=await handler(new Request('https://gateway/chat/completions',{method:'POST',headers:{authorization:'Bearer key','content-type':'application/json'},body:'{}'}));
  assert.equal(invalid.status,400);
  const unknown=await handler(new Request('https://gateway/models/gpt-test/extra',{headers:{authorization:'Bearer key'}}));
  assert.equal(unknown.status,404);assert.equal(called,0);
});
