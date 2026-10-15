import { modernCodexModel, supportsCodexMax, validateCodexReasoning } from "./codex_models.ts";
import { responseEvents } from "./openai_protocol.ts";
type Item = Record<string, any>;

function contentParts(content: unknown, assistant = false): Item[] {
  if (typeof content === "string") {
    return [{ type: assistant ? "output_text" : "input_text", text: content }];
  }
  if (!Array.isArray(content)) throw new Error("Invalid message content");
  return content.map((block) => {
    if (block?.type === "text" && typeof block.text === "string") {
      return {
        type: assistant ? "output_text" : "input_text",
        text: block.text,
      };
    }
    if (!assistant && block?.type === "image") {
      const source = block.source;
      if (
        source?.type === "url" && typeof source.url === "string" &&
        source.url.trim()
      ) {
        return { type: "input_image", image_url: source.url };
      }
      if (
        source?.type === "base64" &&
        ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
          source.media_type,
        ) &&
        typeof source.data === "string" && source.data &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(source.data)
      ) {
        return {
          type: "input_image",
          image_url: `data:${source.media_type};base64,${source.data}`,
        };
      }
      throw new Error("Invalid image source");
    }
    throw new Error("Unsupported message content");
  });
}

// Same direct bridge as upstream apicompat/anthropic_to_responses.go.
export function messagesToResponses(body: Item): Item {
  validateCodexReasoning(body);
  const modern = typeof body.model === "string" ? modernCodexModel(body.model) : undefined;
  if (
    !Array.isArray(body.messages) || !body.messages.length ||
    !Number.isInteger(body.max_tokens) || body.max_tokens <= 0
  ) throw new Error("Invalid messages request");
  const input: Item[] = [];
  if (body.system !== undefined) {
    const content = contentParts(body.system).filter((part) =>
      !part.text.startsWith("x-anthropic-billing-header: ")
    );
    if (content.length) {
      input.push({ type: "message", role: "developer", content });
    }
  }
  for (const message of body.messages) {
    if (!message || !["user", "assistant"].includes(message.role)) {
      throw new Error("Invalid message role");
    }
    if (typeof message.content === "string") {
      input.push({
        type: "message",
        role: message.role,
        content: contentParts(message.content, message.role === "assistant"),
      });
      continue;
    }
    if (!Array.isArray(message.content)) {
      throw new Error("Invalid message content");
    }
    let parts: Item[] = [];
    const flush = () => {
      if (parts.length) {
        input.push({ type: "message", role: message.role, content: parts });
      }
      parts = [];
    };
    for (const block of message.content) {
      if (block?.type === "tool_use" && message.role === "assistant") {
        flush();
        if (
          typeof block.id !== "string" || !block.id ||
          typeof block.name !== "string" || !block.name ||
          !block.input || typeof block.input !== "object" ||
          Array.isArray(block.input)
        ) throw new Error("Invalid tool use");
        input.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      } else if (block?.type === "tool_result" && message.role === "user") {
        flush();
        if (
          typeof block.tool_use_id !== "string" || !block.tool_use_id ||
          (block.is_error !== undefined && typeof block.is_error !== "boolean")
        ) throw new Error("Invalid tool result");
        const result = contentParts(block.content ?? "");
        input.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: result.filter((part) =>
            part.type === "input_text"
          ).map((part) => part.text).join("\n\n") || "(empty)",
        });
        parts.push(...result.filter((part) => part.type === "input_image"));
      } else if (block?.type === "thinking" && message.role === "assistant") {
        flush();
        // Only a returned provider signature can be replayed as encrypted reasoning.
        if (typeof block.signature === "string" && block.signature) {
          input.push({ type: "reasoning", encrypted_content: block.signature });
        }
      } else parts.push(...contentParts([block], message.role === "assistant"));
    }
    flush();
  }
  if (
    body.tools !== undefined &&
    (!Array.isArray(body.tools) ||
      body.tools.some((tool: Item) =>
        typeof tool?.name !== "string" || !tool.name || !tool.input_schema ||
        typeof tool.input_schema !== "object" ||
        Array.isArray(tool.input_schema) || tool.type !== undefined
      ))
  ) {
    throw new Error("Unsupported or invalid tools");
  }
  const choice = body.tool_choice;
  if (
    choice !== undefined &&
    (!choice || !["auto", "any", "none", "tool"].includes(choice.type) ||
      (choice.type === "tool" &&
        (typeof choice.name !== "string" || !choice.name)) ||
      (choice.disable_parallel_tool_use !== undefined &&
        typeof choice.disable_parallel_tool_use !== "boolean"))
  ) throw new Error("Invalid tool choice");
  if (
    body.thinking !== undefined &&
    (!body.thinking ||
      !["enabled", "disabled", "adaptive"].includes(body.thinking.type))
  ) throw new Error("Invalid thinking");
  let effort = body.thinking?.type === "disabled"
    ? "none"
    : body.output_config?.effort ?? modern?.effort ?? "medium";
  if (effort === "max" && !supportsCodexMax(body.model ?? "")) effort = "xhigh";
  if (!["none", "low", "medium", "high", "xhigh", "max"].includes(effort)) {
    throw new Error("Invalid reasoning effort");
  }
  const result: Item = {
    model: modern?.id ?? body.model,
    input,
    instructions: "",
    include: ["reasoning.encrypted_content"],
    reasoning: { effort, ...(effort === "none" ? {} : { summary: "auto" }) },
    parallel_tool_calls: choice?.disable_parallel_tool_use !== true,
    ...(body.tools
      ? {
        tools: body.tools.map((tool: Item) => ({
          type: "function",
          name: tool.name,
          ...(tool.description !== undefined
            ? { description: tool.description }
            : {}),
          parameters: tool.input_schema,
          ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
        })),
      }
      : {}),
    ...(choice
      ? {
        tool_choice: choice.type === "tool"
          ? { type: "function", name: choice.name }
          : choice.type === "any"
          ? "required"
          : choice.type,
      }
      : {}),
  };
  if (body.output_config?.format !== undefined) {
    const format = body.output_config.format;
    if (
      format?.type !== "json_schema" || !format.schema ||
      typeof format.schema !== "object"
    ) throw new Error("Invalid output format");
    result.text = {
      format: {
        type: "json_schema",
        name: "response",
        schema: format.schema,
        strict: true,
      },
    };
  }
  return result;
}

function usage(response: Item): Item {
  const cached = response.usage?.input_tokens_details?.cached_tokens ?? 0;
  return {
    input_tokens: Math.max(0, (response.usage?.input_tokens ?? 0) - cached),
    output_tokens: response.usage?.output_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  };
}
export function responseToMessages(response: Item, id: string): Item {
  const content: Item[] = [];
  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text") {
          content.push({ type: "text", text: part.text });
        }
        if (part.type === "refusal") {
          content.push({ type: "text", text: part.refusal });
        }
      }
    }
    if (item.type === "function_call") {
      const value = JSON.parse(item.arguments || "{}");
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid tool arguments");
      }
      content.push({
        type: "tool_use",
        id: item.call_id,
        name: item.name,
        input: value,
      });
    }
    if (item.type === "reasoning") {
      const thinking = (item.summary ?? []).map((part: Item) => part.text ?? "")
        .join("");
      if (thinking || item.encrypted_content) {
        content.push({
          type: "thinking",
          thinking,
          signature: item.encrypted_content ?? "",
        });
      }
    }
  }
  return {
    id,
    type: "message",
    role: "assistant",
    model: response.model,
    content,
    stop_reason: response.status === "incomplete"
      ? response.incomplete_details?.reason === "max_output_tokens"
        ? "max_tokens"
        : "refusal"
      : content.some((block) => block.type === "tool_use")
      ? "tool_use"
      : "end_turn",
    stop_sequence: null,
    usage: usage(response),
  };
}

export function streamMessages(
  body: ReadableStream<Uint8Array>,
  id: string,
  model: string,
): ReadableStream<Uint8Array> {
  const reader = body.getReader(),
    events = responseEvents(reader),
    encoder = new TextEncoder();
  const blocks = new Map<string, number>(), closed = new Set<number>();
  let cancelled = false, started = false, terminal = false;
  return new ReadableStream({
    async pull(controller) {
      const send = (type: string, data: Item) =>
        controller.enqueue(
          encoder.encode(
            `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
          ),
        );
      const start = (response: Item = {}) => {
        if (started) return;
        started = true;
        send("message_start", {
          message: {
            id,
            type: "message",
            role: "assistant",
            model: response.model ?? model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: usage(response),
          },
        });
      };
      const block = (key: string, content: Item) => {
        if (!blocks.has(key)) {
          const index = blocks.size;
          blocks.set(key, index);
          send("content_block_start", { index, content_block: content });
        }
        return blocks.get(key)!;
      };
      const stop = (index: number) => {
        if (!closed.has(index)) {
          closed.add(index);
          send("content_block_stop", { index });
        }
      };
      try {
        while (!cancelled) {
          const { value: event, done } = await events.next();
          if (cancelled) return;
          if (done) {
            if (!terminal) throw new Error("Missing completion");
            controller.close();
            return;
          }
          if (event.type === "error" || event.type === "response.failed") {
            throw new Error("Generation failed");
          }
          if (event.type === "response.created") {
            start(event.response);
            return;
          }
          start();
          const key = `text:${event.output_index ?? 0}:${
            event.content_index ?? 0
          }`;
          if (
            ["response.output_text.delta", "response.refusal.delta"].includes(
              event.type,
            )
          ) {
            const index = block(key, { type: "text", text: "" });
            send("content_block_delta", {
              index,
              delta: { type: "text_delta", text: event.delta },
            });
            return;
          }
          if (event.type === "response.reasoning_summary_text.delta") {
            const index = block(`reasoning:${event.output_index}`, {
              type: "thinking",
              thinking: "",
              signature: "",
            });
            send("content_block_delta", {
              index,
              delta: { type: "thinking_delta", thinking: event.delta },
            });
            return;
          }
          if (
            event.type === "response.output_item.done" &&
            event.item?.type === "reasoning"
          ) {
            const item = event.item;
            if (
              item.encrypted_content ||
              blocks.has(`reasoning:${event.output_index}`)
            ) {
              const existing = blocks.has(`reasoning:${event.output_index}`);
              const index = block(`reasoning:${event.output_index}`, {
                type: "thinking",
                thinking: "",
                signature: "",
              });
              if (!existing) {
                for (const summary of item.summary ?? []) {
                  if (summary.text) {
                    send("content_block_delta", {
                      index,
                      delta: { type: "thinking_delta", thinking: summary.text },
                    });
                  }
                }
              }
              if (item.encrypted_content) {
                send("content_block_delta", {
                  index,
                  delta: {
                    type: "signature_delta",
                    signature: item.encrypted_content,
                  },
                });
              }
              stop(index);
              return;
            }
          }
          if (
            event.type === "response.output_item.added" &&
            event.item?.type === "function_call"
          ) {
            block(`tool:${event.output_index}`, {
              type: "tool_use",
              id: event.item.call_id,
              name: event.item.name,
              input: {},
            });
            if (event.item.arguments) {
              send("content_block_delta", {
                index: blocks.get(`tool:${event.output_index}`),
                delta: {
                  type: "input_json_delta",
                  partial_json: event.item.arguments,
                },
              });
            }
            return;
          }
          if (event.type === "response.function_call_arguments.delta") {
            const index = blocks.get(`tool:${event.output_index}`);
            if (index === undefined) throw new Error("Missing tool header");
            send("content_block_delta", {
              index,
              delta: { type: "input_json_delta", partial_json: event.delta },
            });
            return;
          }
          if (
            [
              "response.output_text.done",
              "response.refusal.done",
              "response.function_call_arguments.done",
            ].includes(event.type)
          ) {
            const index = blocks.get(
              event.type === "response.function_call_arguments.done"
                ? `tool:${event.output_index}`
                : key,
            );
            if (index !== undefined) {
              stop(index);
              return;
            }
          }
          if (
            ["response.completed", "response.incomplete"].includes(event.type)
          ) {
            const message = responseToMessages(event.response, id);
            // Recover terminal-only output without repeating blocks already streamed.
            for (
              const [outputIndex, item] of (event.response.output ?? [])
                .entries()
            ) {
              const key = item.type === "function_call"
                ? `tool:${outputIndex}`
                : item.type === "reasoning"
                ? `reasoning:${outputIndex}`
                : `text:${outputIndex}:0`;
              if (blocks.has(key)) {
                const index = blocks.get(key)!;
                if (
                  item.type === "reasoning" && !closed.has(index) &&
                  item.encrypted_content
                ) {
                  send("content_block_delta", {
                    index,
                    delta: {
                      type: "signature_delta",
                      signature: item.encrypted_content,
                    },
                  });
                }
                continue;
              }
              for (
                const content of responseToMessages({
                  ...event.response,
                  output: [item],
                }, id).content
              ) {
                const index = block(key, content);
                stop(index);
              }
            }
            for (const index of blocks.values()) stop(index);
            send("message_delta", {
              delta: { stop_reason: message.stop_reason, stop_sequence: null },
              usage: message.usage,
            });
            send("message_stop", {});
            terminal = true;
            return;
          }
        }
      } catch {
        if (cancelled) return;
        send("error", {
          error: {
            type: "api_error",
            message: "Upstream stream failed or incomplete",
          },
        });
        await events.return(undefined);
        controller.close();
      }
    },
    async cancel() {
      cancelled = true;
      await reader.cancel().catch(() => {});
      await events.return(undefined);
    },
  });
}
