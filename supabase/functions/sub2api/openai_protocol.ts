// OpenAI Chat Completions ↔ Responses protocol conversion.
type Item = Record<string, any>;

function textContent(value: unknown, role: string): string | Item[] | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) throw new Error("Unsupported chat content");
  const parts = value.map((part): Item | null => {
    if (part?.type === "text" && typeof part.text === "string") {
      return {
        type: role === "assistant" ? "output_text" : "input_text",
        text: part.text,
      };
    }
    if (part?.type === "image_url" && (role === "user" || role === "tool")) {
      const image = part.image_url;
      if (
        typeof image?.url !== "string" || !image.url.trim() ||
        (image.detail !== undefined &&
          !["auto", "low", "high", "original"].includes(image.detail))
      ) {
        throw new Error("Invalid chat image");
      }
      return {
        type: "input_image",
        image_url: image.url,
        ...(image.detail ? { detail: image.detail } : {}),
      };
    }
    if (part?.type === "file" && role === "user") {
      const file = part.file;
      if (file !== undefined && (file === null || typeof file !== "object" || Array.isArray(file))) throw new Error("Invalid chat file");
      for (const field of ["filename", "file_data", "file_id"]) {
        if (file?.[field] !== undefined && typeof file[field] !== "string") throw new Error("Invalid chat file");
      }
      // Upstream skips file parts without a usable payload or provider file ID.
      if (!file?.file_data && !file?.file_id) return null;
      return {
        type: "input_file",
        ...Object.fromEntries(["filename", "file_data", "file_id"].filter(field => file[field]).map(field => [field, file[field]])),
      };
    }
    if (
      part?.type === "refusal" && role === "assistant" &&
      typeof part.refusal === "string"
    ) {
      return { type: "refusal", refusal: part.refusal };
    }
    throw new Error("Unsupported chat content");
  }).filter((part): part is Item => part !== null);
  return parts.length ? parts : "";
}

export function chatToResponses(body: Item): Item {
  if (
    !Array.isArray(body.messages) || !body.messages.length ||
    (body.n !== undefined && body.n !== 1)
  ) {
    throw new Error("Invalid chat messages");
  }
  body = structuredClone(body);
  const used = new Set(
    body.messages.flatMap((message: Item) =>
      (message?.tool_calls ?? []).map((call: Item) => call.id)
    ),
  );
  const pending = new Map<string, string[]>();
  let serial = 0;
  for (const message of body.messages) {
    if (
      message?.role === "assistant" && message.function_call &&
      !message.tool_calls?.length
    ) {
      let id: string;
      do {
        id = `call_legacy_${++serial}`;
      } while (used.has(id));
      used.add(id);
      const queue = pending.get(message.function_call.name) ?? [];
      queue.push(id);
      pending.set(message.function_call.name, queue);
      message.tool_calls = [{
        type: "function",
        id,
        function: message.function_call,
      }];
    }
    if (message?.role === "function") {
      message.role = "tool";
      message.tool_call_id = pending.get(message.name)?.shift();
    }
  }
  if (body.tools === undefined && body.functions !== undefined) {
    if (!Array.isArray(body.functions)) {
      throw new Error("Invalid legacy functions");
    }
    body.tools = body.functions.map((fn: Item) => ({
      type: "function",
      function: fn,
    }));
  }
  if (body.tool_choice === undefined && body.function_call !== undefined) {
    body.tool_choice = typeof body.function_call === "string"
      ? body.function_call
      : { type: "function", function: body.function_call };
  }
  const input: Item[] = [], instructions: string[] = [];
  if (body.instructions !== undefined) {
    if (typeof body.instructions !== "string") {
      throw new Error("Invalid instructions");
    }
    instructions.push(body.instructions);
  }
  for (const message of body.messages) {
    if (
      !message ||
      !["system", "developer", "user", "assistant", "tool"].includes(
        message.role,
      )
    ) throw new Error("Invalid chat role");
    const content = textContent(message.content, message.role);
    if (message.role === "system" || message.role === "developer") {
      if (content === null) throw new Error("Missing instructions");
      instructions.push(
        typeof content === "string"
          ? content
          : content.map((part) => part.text).join("\n"),
      );
      continue;
    }
    if (message.role === "tool") {
      if (
        typeof message.tool_call_id !== "string" || !message.tool_call_id ||
        content === null
      ) throw new Error("Invalid tool result");
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: typeof content === "string"
          ? content
          : content.filter((part) => part.type === "input_text").map((part) =>
            part.text
          ).join("\n"),
      });
      if (
        Array.isArray(content) &&
        content.some((part) => part.type === "input_image")
      ) {
        input.push({
          type: "message",
          role: "user",
          content: content.filter((part) => part.type === "input_image"),
        });
      }
      continue;
    }
    if (content !== null) {
      input.push({ type: "message", role: message.role, content });
    }
    if (
      message.tool_calls !== undefined &&
      (message.role !== "assistant" || !Array.isArray(message.tool_calls))
    ) throw new Error("Invalid tool calls");
    for (const call of message.tool_calls ?? []) {
      if (
        call?.type !== "function" || typeof call.id !== "string" || !call.id ||
        typeof call.function?.name !== "string" || !call.function.name ||
        typeof call.function.arguments !== "string"
      ) throw new Error("Invalid tool call");
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
    }
    if (content === null && !message.tool_calls?.length) {
      throw new Error("Missing message content");
    }
  }
  if (
    body.tools !== undefined &&
    (!Array.isArray(body.tools) ||
      body.tools.some((tool: Item) =>
        tool?.type !== "function" || typeof tool.function?.name !== "string" ||
        !tool.function.name
      ))
  ) throw new Error("Invalid tools");
  let choice = body.tool_choice;
  if (choice && typeof choice === "object") {
    if (
      choice.type !== "function" ||
      typeof (choice.function?.name ?? choice.name) !== "string" ||
      !(choice.function?.name ?? choice.name)
    ) throw new Error("Invalid tool choice");
    choice = { type: "function", name: choice.function?.name ?? choice.name };
  } else if (
    choice !== undefined && !["auto", "none", "required"].includes(choice)
  ) throw new Error("Invalid tool choice");
  if (
    body.parallel_tool_calls !== undefined &&
    typeof body.parallel_tool_calls !== "boolean"
  ) throw new Error("Invalid parallel tool calls");
  const result: Item = {
    model: body.model,
    input,
    instructions: instructions.join("\n\n"),
    include: ["reasoning.encrypted_content"],
    ...(body.tools
      ? {
        tools: body.tools.map((tool: Item) => ({
          ...tool.function,
          type: "function",
        })),
      }
      : {}),
    ...(choice !== undefined ? { tool_choice: choice } : {}),
    ...(body.parallel_tool_calls !== undefined
      ? { parallel_tool_calls: body.parallel_tool_calls }
      : {}),
  };
  for (const field of ["service_tier", "prompt_cache_key"]) {
    if (body[field] !== undefined) result[field] = body[field];
  }
  if (body.reasoning_effort !== undefined) {
    if (
      !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        body.reasoning_effort,
      )
    ) throw new Error("Invalid reasoning effort");
    result.reasoning = { effort: body.reasoning_effort, summary: "auto" };
  }
  if (body.response_format !== undefined) {
    const format = body.response_format;
    if (
      !format || !["text", "json_object", "json_schema"].includes(format.type)
    ) throw new Error("Invalid response format");
    if (
      format.type === "json_schema" &&
      (!format.json_schema || typeof format.json_schema.name !== "string" ||
        !format.json_schema.schema)
    ) throw new Error("Invalid JSON schema");
    result.text = {
      format: format.type === "json_schema"
        ? { ...format.json_schema, type: "json_schema" }
        : { type: format.type },
    };
  }
  return result;
}

// Network chunks may split SSE frames, JSON and UTF-8 characters.
export async function* responseEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Item> {
  const decoder = new TextDecoder();
  let pending = "";
  const frameEvent = (frame: string): Item | undefined => {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data);
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      throw new Error("Invalid upstream event");
    }
    return event;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        if (boundary.index > 1_048_576) {
          throw new Error("Upstream event too large");
        }
        const event = frameEvent(pending.slice(0, boundary.index));
        pending = pending.slice(boundary.index + boundary[0].length);
        if (event) yield event;
      }
      if (pending.length > 1_048_576) {
        throw new Error("Upstream event too large");
      }
      if (done) {
        const event = frameEvent(pending);
        if (event) yield event;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function completedResponse(
  body: ReadableStream<Uint8Array>,
): Promise<Item> {
  let completed: Item | undefined, failed = false;
  const outputItems = new Map<number, Item>();
  for await (const event of responseEvents(body.getReader())) {
    if (["response.failed", "error"].includes(event.type)) failed = true;
    if (event.type === "response.output_item.done" && Number.isInteger(event.output_index) && event.output_index >= 0 && event.item && typeof event.item === "object" && !Array.isArray(event.item)) {
      outputItems.set(event.output_index, event.item);
    }
    if (["response.completed", "response.incomplete"].includes(event.type)) {
      completed = event.response;
    }
  }
  if (failed) throw new Error("Upstream generation failed");
  if (!completed || typeof completed !== "object") {
    throw new Error("Upstream ended without completion");
  }
  // Some providers omit completed items from the terminal response envelope.
  if ((!Array.isArray(completed.output) || completed.output.length === 0) && outputItems.size) {
    completed = { ...completed, output: [...outputItems].sort(([a], [b]) => a - b).map(([, item]) => item) };
  }
  return completed;
}

export function responseToChat(response: Item, id: string): Item {
  const output = response.output ?? [];
  const text = output.filter((item: Item) => item.type === "message")
    .flatMap((item: Item) => item.content ?? []).filter((part: Item) =>
      part.type === "output_text"
    )
    .map((part: Item) => part.text).join("");
  const refusal = output.filter((item: Item) => item.type === "message")
    .flatMap((item: Item) => item.content ?? [])
    .filter((part: Item) => part.type === "refusal").map((part: Item) =>
      part.refusal
    ).join("");
  const calls = output.filter((item: Item) => item.type === "function_call")
    .map((item: Item) => ({
      id: item.call_id,
      type: "function",
      function: { name: item.name, arguments: item.arguments },
    }));
  const usage = response.usage ?? {};
  return {
    id,
    object: "chat.completion",
    created: response.created_at ?? Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text || null,
        ...(refusal ? { refusal } : {}),
        ...(calls.length ? { tool_calls: calls } : {}),
      },
      finish_reason: response.status === "incomplete"
        ? (response.incomplete_details?.reason === "max_output_tokens"
          ? "length"
          : "content_filter")
        : calls.length
        ? "tool_calls"
        : "stop",
    }],
    usage: {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: usage.total_tokens ??
        (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      ...(usage.input_tokens_details
        ? { prompt_tokens_details: usage.input_tokens_details }
        : {}),
      ...(usage.output_tokens_details
        ? { completion_tokens_details: usage.output_tokens_details }
        : {}),
    },
  };
}

export function streamChat(
  body: ReadableStream<Uint8Array>,
  id: string,
  model: string,
  includeUsage = false,
): ReadableStream<Uint8Array> {
  const reader = body.getReader(),
    events = responseEvents(reader),
    encoder = new TextEncoder();
  const created = Math.floor(Date.now() / 1000),
    calls = new Map<number, number>();
  let cancelled = false,
    terminal = false,
    failed = false,
    textSent = false,
    refusalSent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const send = (value: Item) =>
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(value)}\n\n`),
        );
      const chunk = (delta: Item, finish: string | null = null) => ({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });
      try {
        while (!cancelled) {
          const { value: event, done } = await events.next();
          if (cancelled) return;
          if (done) {
            if (failed) throw new Error("Upstream generation failed");
            if (!terminal) throw new Error("Upstream ended without completion");
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          }
          if (["response.failed", "error"].includes(event.type)) {
            failed = true;
            continue;
          }
          if (failed) continue;
          if (event.type === "response.created") {
            model = event.response?.model ?? model;
            send(chunk({ role: "assistant", content: "" }));
            return;
          }
          if (event.type === "response.output_text.delta") {
            textSent = true;
            send(chunk({ content: event.delta }));
            return;
          }
          if (event.type === "response.refusal.delta") {
            refusalSent = true;
            send(chunk({ refusal: event.delta }));
            return;
          }
          if (
            event.type === "response.output_item.added" &&
            event.item?.type === "function_call"
          ) {
            const index = calls.size;
            calls.set(event.output_index, index);
            send(
              chunk({
                tool_calls: [{
                  index,
                  id: event.item.call_id,
                  type: "function",
                  function: {
                    name: event.item.name,
                    arguments: event.item.arguments ?? "",
                  },
                }],
              }),
            );
            return;
          }
          if (event.type === "response.function_call_arguments.delta") {
            const index = calls.get(event.output_index);
            if (index === undefined) {
              throw new Error("Missing tool stream header");
            }
            send(
              chunk({
                tool_calls: [{ index, function: { arguments: event.delta } }],
              }),
            );
            return;
          }
          if (
            ["response.completed", "response.incomplete"].includes(event.type)
          ) {
            model = event.response?.model ?? model;
            const completed = responseToChat(event.response, id);
            const message = completed.choices[0].message;
            if (!textSent && message.content) {
              send(chunk({ content: message.content }));
            }
            if (!refusalSent && message.refusal) {
              send(chunk({ refusal: message.refusal }));
            }
            for (
              const [outputIndex, item] of (event.response.output ?? [])
                .entries()
            ) {
              if (item.type === "function_call" && !calls.has(outputIndex)) {
                const index = calls.size;
                calls.set(outputIndex, index);
                send(
                  chunk({
                    tool_calls: [{
                      index,
                      id: item.call_id,
                      type: "function",
                      function: {
                        name: item.name,
                        arguments: item.arguments ?? "",
                      },
                    }],
                  }),
                );
              }
            }
            send(chunk({}, completed.choices[0].finish_reason));
            if (includeUsage) {
              send({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [],
                usage: completed.usage,
              });
            }
            terminal = true;
            return;
          }
        }
      } catch {
        if (cancelled) return;
        send({
          error: {
            message: "Upstream stream failed or incomplete",
            type: "server_error",
            code: "upstream_error",
          },
        });
        await events.return(undefined);
        controller.close();
      }
    },
    async cancel() {
      cancelled = true;
      // Cancel the reader first: the iterator may be awaiting an upstream read.
      await reader.cancel().catch(() => {});
      await events.return(undefined);
    },
  });
}
