import assert from "node:assert/strict";
import test from "node:test";
import {
  messagesToResponses,
  responseToMessages,
  streamMessages,
} from "../supabase/functions/sub2api/anthropic_protocol.ts";
const complete = {
  model: "gpt-test",
  status: "completed",
  output: [
    { type: "message", content: [{ type: "output_text", text: "你好" }] },
    {
      type: "function_call",
      call_id: "toolu_1",
      name: "lookup",
      arguments: '{"q":"hi"}',
    },
  ],
  usage: {
    input_tokens: 12,
    output_tokens: 3,
    input_tokens_details: { cached_tokens: 2 },
  },
};
function source(events) {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""),
  );
  let offset = 0;
  return new ReadableStream({
    pull(c) {
      if (offset === bytes.length) c.close();
      else c.enqueue(bytes.slice(offset, ++offset));
    },
  });
}
test("Messages bridge preserves system, images, tool calls/results and disables parallel tools", () => {
  const converted = messagesToResponses({
    model: "gpt-test",
    max_tokens: 10,
    system: [{ type: "text", text: "policy" }],
    messages: [
      {
        role: "user",
        content: [{
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "YQ==" },
        }],
      },
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "toolu_1",
          name: "lookup",
          input: { q: "hi" },
        }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [{ type: "text", text: "result" }, {
            type: "image",
            source: { type: "url", url: "https://example.com/image.png" },
          }],
        }],
      },
    ],
    tools: [{
      name: "lookup",
      description: "Search",
      input_schema: { type: "object" },
    }],
    tool_choice: {
      type: "tool",
      name: "lookup",
      disable_parallel_tool_use: true,
    },
    thinking: { type: "disabled" },
  });
  assert.equal(converted.input[0].role, "developer");
  assert.equal(
    converted.input[1].content[0].image_url,
    "data:image/png;base64,YQ==",
  );
  assert.equal(converted.input[2].call_id, converted.input[3].call_id);
  assert.equal(converted.input[3].output, "result");
  assert.equal(converted.input[4].content[0].type, "input_image");
  assert.equal(converted.parallel_tool_calls, false);
  assert.equal(converted.reasoning.effort, "none");
  assert.equal(converted.tools[0].description, "Search");
  assert.deepEqual(converted.tool_choice, { type: "function", name: "lookup" });
  assert.throws(() =>
    messagesToResponses({
      max_tokens: 1,
      messages: [{ role: "user", content: [{ type: "document", source: {} }] }],
    })
  );
});
test("Messages output preserves tool JSON, stop reasons and separate cache usage", () => {
  const result = responseToMessages(complete, "msg_test");
  assert.equal(result.content[0].text, "你好");
  assert.deepEqual(result.content[1].input, { q: "hi" });
  assert.equal(result.stop_reason, "tool_use");
  assert.deepEqual(result.usage, {
    input_tokens: 10,
    output_tokens: 3,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 2,
  });
  assert.equal(
    responseToMessages({
      ...complete,
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    }, "id").stop_reason,
    "max_tokens",
  );
});
test('Messages JSON and SSE preserve cache creation separately from uncached and cached input',async()=>{
 for(const total of [12,2]){
  const response={...complete,usage:{input_tokens:total,output_tokens:3,cache_creation_input_tokens:4,input_tokens_details:{cached_tokens:2}}};
  const expected={input_tokens:Math.max(0,total-6),output_tokens:3,cache_creation_input_tokens:4,cache_read_input_tokens:2};
  assert.deepEqual(responseToMessages(response,'id').usage,expected);
  const text=await new Response(streamMessages(source([{type:'response.created',response},{type:'response.completed',response}]),'id','gpt-test')).text();
  const values=text.split('\n\n').filter(Boolean).map(frame=>JSON.parse(frame.split('\ndata: ')[1]));
  assert.deepEqual(values[0].message.usage,expected);
  assert.deepEqual(values.find(event=>event.type==='message_delta').usage,expected);
 }
});

test("Messages SSE emits fragmented Unicode text, tool input, terminal usage and lifecycle", async () => {
  const events = [
    { type: "response.created", response: { model: "gpt-test" } },
    { type: "response.output_text.delta", output_index: 0, delta: "你好" },
    { type: "response.output_text.done", output_index: 0 },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "function_call", call_id: "toolu_1", name: "lookup" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      delta: '{"q":"hi"}',
    },
    { type: "response.completed", response: complete },
  ];
  const text = await new Response(
    streamMessages(source(events), "msg_test", "gpt-test"),
  ).text();
  const values = text.split("\n\n").filter(Boolean).map((frame) =>
    JSON.parse(frame.split("\ndata: ")[1])
  );
  assert.equal(values[0].type, "message_start");
  assert.equal(values[2].delta.text, "你好");
  assert.equal(values[4].content_block.id, "toolu_1");
  assert.equal(values[5].delta.partial_json, '{"q":"hi"}');
  assert.equal(values.at(-2).usage.cache_read_input_tokens, 2);
  assert.equal(values.at(-1).type, "message_stop");
  const error = await new Response(
    streamMessages(
      source([{
        type: "response.failed",
        response: { error: { message: "secret" } },
      }]),
      "id",
      "test",
    ),
  ).text();
  assert.match(error, /event: error/);
  assert.equal(error.includes("secret"), false);
});
test("Messages stream cancellation interrupts a pending read", async () => {
  let cancelled = false;
  const stream = streamMessages(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
    "id",
    "test",
  );
  const reader = stream.getReader();
  const pending = reader.read();
  await reader.cancel();
  await pending;
  assert.equal(cancelled, true);
});

test("Messages thinking SSE retains provider signature for the next turn", async () => {
  const response = {
    ...complete,
    output: [{
      type: "reasoning",
      summary: [{ type: "summary_text", text: "reason" }],
      encrypted_content: "signature",
    }],
  };
  const text = await new Response(streamMessages(
    source([
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        delta: "reason",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: response.output[0],
      },
      { type: "response.completed", response },
    ]),
    "id",
    "test",
  )).text();
  assert.match(text, /"thinking_delta","thinking":"reason"/);
  assert.match(text, /"signature_delta","signature":"signature"/);
  const replay = messagesToResponses({
    model: "test",
    max_tokens: 1,
    messages: [{
      role: "assistant",
      content: responseToMessages(response, "id").content,
    }],
  });
  assert.equal(replay.input[0].encrypted_content, "signature");
});
