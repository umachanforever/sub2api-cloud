export type Usage = {
  input: number | null;
  output: number | null;
  cacheCreation: number | null;
  cacheRead: number | null;
  outcome: "completed" | "failed" | "incomplete" | "cancelled";
  firstTokenMs?: number;
};

export function hasGeneratedToken(event: Record<string, any>): boolean {
  const nonempty = (value: unknown) => typeof value === "string" && value.length > 0;
  if (["image_generation.partial_image", "image_generation.completed"].includes(event.type)) return nonempty(event.partial_image_b64) || nonempty(event.b64_json);
  if (typeof event.type === "string" && event.type.startsWith("response.") && event.type.endsWith(".delta")) return nonempty(event.delta);
  if (event.type === "content_block_delta") return [event.delta?.text, event.delta?.thinking, event.delta?.partial_json].some(nonempty);
  if (Array.isArray(event.choices)) return event.choices.some((choice: any) =>
    [choice.delta?.content, choice.delta?.reasoning_content, choice.delta?.audio?.data, choice.delta?.function_call?.name, choice.delta?.function_call?.arguments].some(nonempty) ||
    Array.isArray(choice.delta?.tool_calls) && choice.delta.tool_calls.some((call: any) =>
      nonempty(call.function?.name) || nonempty(call.function?.arguments)));
  return Array.isArray(event.candidates) && event.candidates.some((candidate: any) =>
    Array.isArray(candidate.content?.parts) && candidate.content.parts.some((part: any) =>
      nonempty(part.text) || nonempty(part.functionCall?.name) || nonempty(part.inlineData?.data)));
}

// shortcut: only one-line Codex SSE data records up to 1 MiB are inspected; upgrade if upstream changes framing.
export class UsageObserver {
  usage: Usage = {
    input: null,
    output: null,
    cacheCreation: null,
    cacheRead: null,
    outcome: "incomplete",
  };
  private decoder = new TextDecoder();
  private line = "";
  private skipping = false;
  private started: number;
  constructor(started = Date.now()) { this.started = started; }

  push(bytes: Uint8Array) {
    this.consume(this.decoder.decode(bytes, { stream: true }));
  }
  end() {
    this.consume(this.decoder.decode() + "\n");
  }
  private consume(text: string) {
    for (const part of text.split(/(?<=\n)/)) {
      if (!this.skipping) this.line += part;
      if (this.line.length > 1_048_576) {
        this.line = "";
        this.skipping = true;
      }
      if (!part.endsWith("\n")) continue;
      if (!this.skipping) this.record(this.line.trim());
      this.line = "";
      this.skipping = false;
    }
  }
  private record(line: string) {
    if (!line.startsWith("data:")) return;
    try {
      const event = JSON.parse(line.slice(5).trim());
      if (this.usage.firstTokenMs === undefined && hasGeneratedToken(event)) this.usage.firstTokenMs = Math.max(0, Math.min(2147483647, Date.now() - this.started));
      if (
        ["response.completed", "response.failed", "response.incomplete"]
          .includes(event.type)
      ) {
        this.usage.outcome = event.type === "response.completed" && event.response?.status !== 'incomplete'
          ? "completed"
          : event.type === "response.failed"
          ? "failed"
          : "incomplete";
        const usage = event.response?.usage;
        if (
          Number.isSafeInteger(usage?.input_tokens) && usage.input_tokens >= 0
        ) this.usage.input = usage.input_tokens;
        if (
          Number.isSafeInteger(usage?.output_tokens) && usage.output_tokens >= 0
        ) this.usage.output = usage.output_tokens;
        const cached = usage?.input_tokens_details?.cached_tokens;
        if (Number.isSafeInteger(cached) && cached >= 0) this.usage.cacheRead = cached;
        const created = usage?.cache_creation_input_tokens;
        if (Number.isSafeInteger(created) && created >= 0) this.usage.cacheCreation = created;
      }
    } catch { /* Non-JSON SSE records do not affect forwarding. */ }
  }
}

export function trackedStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  finish: (usage: Usage) => Promise<void>,
  observer: { usage: Usage; push(bytes: Uint8Array): void; end(): void } =
    new UsageObserver(),
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let settled = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const settle = async (outcome?: Usage["outcome"]) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", abort);
    try {
      observer.end();
    } catch {
      outcome = "failed";
    }
    if (outcome) observer.usage.outcome = outcome;
    const persistence = finish(observer.usage);
    (globalThis as typeof globalThis & {
      EdgeRuntime?: { waitUntil: (task: Promise<unknown>) => void };
    }).EdgeRuntime?.waitUntil(persistence);
    await persistence;
  };
  const abort = () => {
    void reader.cancel().catch(() => {});
    controller.error(new Error("upstream_aborted"));
    void settle(
      signal.reason?.name === "TimeoutError" ? "incomplete" : "cancelled",
    );
  };
  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull() {
      try {
        const { done, value } = await reader.read();
        if (settled) return;
        if (done) {
          await settle();
          controller.close();
        } else {
          observer.push(value);
          controller.enqueue(value);
        }
      } catch (error) {
        if (!settled) {
          await reader.cancel().catch(() => {});
          await settle("failed");
          controller.error(error);
        }
      }
    },
    async cancel() {
      const finished = settle("cancelled");
      await reader.cancel().catch(() => {});
      await finished;
    },
  });
}
