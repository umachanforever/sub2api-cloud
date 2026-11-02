import { mappedTarget } from "./model_mapping.ts";

type ObjectValue = Record<string, any>;

export function resolveThinkingVariant(
  requested: string,
  mapping: Record<string, string>,
  body?: ObjectValue,
): string | undefined {
  const model = requested.trim().replace(/^models\//, "");
  if (
    !model.startsWith("gemini-") || /-(low|medium|high|tiered)$/.test(model)
  ) return;
  const mapped = mappedTarget(mapping, model, "antigravity");
  if (mapped !== undefined && mapped.trim() !== model) return;
  const thinking = body?.generationConfig?.thinkingConfig;
  const effort = body?.reasoning_effort ?? body?.reasoning?.effort;
  let level = String(
    thinking?.thinkingLevel ?? (!thinking && !body?.thinking
      ? ({
        none: "low",
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "high",
        max: "high",
      } as Record<string, string>)[String(effort)]
      : "") ??
      "",
  ).trim().toLowerCase();
  if (!["low", "medium", "high"].includes(level)) {
    const budget = thinking?.thinkingBudget ?? body?.thinking?.budget_tokens;
    level = body?.thinking?.type === "disabled"
      ? "low"
      : typeof budget !== "number" || budget < 0 || (!thinking && budget === 0)
      ? "high"
      : budget <= 1024
      ? "low"
      : budget <= 8192
      ? "medium"
      : "high";
  }
  for (
    const suffix of [...new Set([level, "high", "medium", "low", "tiered"])]
  ) {
    const candidate = model + "-" + suffix;
    const target = mapped !== undefined
      ? (Object.hasOwn(mapping, candidate) ? mapping[candidate] : undefined)
      : mappedTarget(mapping, candidate, "antigravity");
    if (target?.trim()) return target.trim();
  }
}

export function paidAntigravityTier(value: unknown): boolean {
  return typeof value === "string" &&
    /^(pro|ultra|g1-(?:pro|ultra)-.+-tier)$/.test(value.trim().toLowerCase());
}

export function normalizeAntigravityModel(model: string): string {
  let value = model.trim().toLowerCase();
  for (
    const prefix of [
      "/publishers/google/models/",
      "/publishers/anthropic/models/",
      "/models/",
    ]
  ) {
    const index = value.lastIndexOf(prefix);
    if (index >= 0) return value.slice(index + prefix.length);
  }
  return value.replace(
    /^(publishers\/(google|anthropic)\/models\/|models\/)/,
    "",
  );
}

function retryDuration(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))+$/.test(value)
  ) return 0;
  const units: Record<string, number> = {
    ns: 1e-6,
    us: 0.001,
    "µs": 0.001,
    "μs": 0.001,
    ms: 1,
    s: 1000,
    m: 60000,
    h: 3600000,
  };
  return [...value.matchAll(/((?:\d+(?:\.\d*)?|\.\d+))(ns|us|µs|μs|ms|s|m|h)/g)]
    .reduce((ms, match) => ms + Number(match[1]) * units[match[2]], 0);
}

export function retryInfo(
  status: number,
  headers: HeadersInit,
  value: ObjectValue,
) {
  const error = value?.error ?? value?.response?.error ?? {};
  const details = Array.isArray(error.details) ? error.details : [];
  let model = "", rateLimited = false, capacity = false, delay = 0;
  for (const detail of details) {
    if (detail?.["@type"] === "type.googleapis.com/google.rpc.ErrorInfo") {
      if (typeof detail.metadata?.model === "string") {
        model = normalizeAntigravityModel(detail.metadata.model);
      }
      rateLimited ||= detail.reason === "RATE_LIMIT_EXCEEDED";
      capacity ||= detail.reason === "MODEL_CAPACITY_EXHAUSTED";
    } else if (
      detail?.["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
    ) delay = retryDuration(detail.retryDelay);
  }
  const modelScoped = [429, 503].includes(status) && !!model &&
    ((error.status === "RESOURCE_EXHAUSTED" && rateLimited) ||
      (error.status === "UNAVAILABLE" && capacity));
  if (modelScoped && delay <= 0) delay = 30000;
  // Retry-After remains a fallback for unstructured errors; structured RPC data wins.
  if (!modelScoped) {
    const raw = new Headers(headers).get("retry-after");
    const parsed = raw
      ? (/^\d+(\.\d+)?$/.test(raw)
        ? Number(raw) * 1000
        : Date.parse(raw) - Date.now())
      : 0;
    delay = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }
  return {
    modelScoped,
    delay: Math.min(Math.max(delay, 0), 86400000),
    capacity: modelScoped && capacity,
    quota: status === 429 &&
      /quota[_ ]exhausted/.test(JSON.stringify(error).toLowerCase()),
    model: modelScoped ? model : "",
  };
}

export function signatureError(message: string): boolean {
  return /signature|thought_signature/i.test(message) ||
    /expected/i.test(message) && /thinking|redacted_thinking/i.test(message);
}

// Recover only errors that explicitly identify an invalid signature or budget.
// Preserve caller caps. Claude tool history is downgraded to text only on a
// second signature failure, matching upstream's staged recovery.
export function recoverRequest(
  body: ObjectValue,
  message: string,
  recovery: { claude?: boolean; tools?: boolean } = {},
): ObjectValue | undefined {
  const fixed = structuredClone(body);
  let changed = false;
  if (signatureError(message)) {
    if (recovery.claude && fixed.request?.generationConfig?.thinkingConfig) {
      delete fixed.request.generationConfig.thinkingConfig;
      changed = true;
    }
    if (!recovery.claude) {
      const replace = (value: unknown): void => {
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
          if (
            key === "thoughtSignature" &&
            child !== "skip_thought_signature_validator"
          ) {
            (value as ObjectValue)[key] = "skip_thought_signature_validator";
            changed = true;
          } else replace(child);
        }
      };
      replace(fixed.request);
    }
    for (
      const content of Array.isArray(fixed.request?.contents)
        ? fixed.request.contents
        : []
    ) {
      for (const part of Array.isArray(content?.parts) ? content.parts : []) {
        if (!part || typeof part !== "object" || Array.isArray(part)) continue;
        if (recovery.claude) {
          if (
            part.thought ||
            typeof part.thoughtSignature === "string" && !part.functionCall &&
              !part.functionResponse
          ) {
            delete part.thought;
            delete part.thoughtSignature;
            changed = true;
          }
          if (recovery.tools && (part.functionCall || part.functionResponse)) {
            const name = part.functionCall ? "tool_use" : "tool_result";
            const value = part.functionCall ?? part.functionResponse;
            delete part.functionCall;
            delete part.functionResponse;
            delete part.thoughtSignature;
            part.text = `(${name}) ${JSON.stringify(value)}`;
            changed = true;
          }
        } else if (
          typeof part.thoughtSignature === "string" &&
          part.thoughtSignature !== "skip_thought_signature_validator"
        ) {
          part.thoughtSignature = "skip_thought_signature_validator";
          changed = true;
        }
      }
    }
  } else if (
    /(thinking.?budget|budget_tokens)/i.test(message) &&
    /(max.?output|max_tokens|greater|less|smaller|minimum|constraint)/i.test(
      message,
    )
  ) {
    const config = fixed.request?.generationConfig,
      thinking = config?.thinkingConfig;
    if (
      thinking && Number.isFinite(thinking.thinkingBudget) &&
      Number.isFinite(config.maxOutputTokens) && config.maxOutputTokens > 1024
    ) {
      const budget = Math.max(
        1024,
        Math.min(32000, config.maxOutputTokens - 1024),
      );
      if (budget !== thinking.thinkingBudget) {
        thinking.thinkingBudget = budget;
        changed = true;
      }
    }
  }
  return changed ? fixed : undefined;
}
