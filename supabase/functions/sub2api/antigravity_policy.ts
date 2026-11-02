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

export function retryInfo(
  status: number,
  headers: HeadersInit,
  value: ObjectValue,
) {
  const error = value?.error ?? value?.response?.error ?? {};
  const details = Array.isArray(error.details) ? error.details : [];
  const text = JSON.stringify(error).toLowerCase();
  const capacity = text.includes("model_capacity_exhausted");
  const quota = /quota[_ ]exhausted/.test(text);
  let delay = 0;
  const retry = new Headers(headers).get("retry-after");
  if (retry) {
    delay = /^\d+(\.\d+)?$/.test(retry)
      ? Number(retry) * 1000
      : Math.max(0, Date.parse(retry) - Date.now());
  }
  for (const detail of details) {
    const raw = detail?.retryDelay;
    const seconds = typeof raw === "string" && /^\d+(\.\d+)?s$/.test(raw)
      ? parseFloat(raw)
      : typeof raw === "object" && raw
      ? Number(raw.seconds ?? 0) + Number(raw.nanos ?? 0) / 1e9
      : 0;
    if (Number.isFinite(seconds)) delay = Math.max(delay, seconds * 1000);
  }
  const modelScoped = [429, 503].includes(status) &&
    (capacity || quota ||
      details.some((detail: ObjectValue) =>
        detail?.metadata?.model || detail?.metadata?.modelName
      ));
  if (modelScoped && !capacity && !quota && delay === 0) delay = 30000;
  return {
    modelScoped,
    delay: Number.isFinite(delay) ? Math.min(Math.max(delay, 0), 86400000) : 0,
    capacity,
    quota,
  };
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
  if (/signature|thought_signature/i.test(message)) {
    if (recovery.claude && fixed.request?.generationConfig?.thinkingConfig) {
      delete fixed.request.generationConfig.thinkingConfig;
      changed = true;
    }
    for (const content of Array.isArray(fixed.request?.contents) ? fixed.request.contents : []) {
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
