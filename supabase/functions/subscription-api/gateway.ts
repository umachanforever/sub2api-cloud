export type Platform = "openai" | "anthropic" | "gemini" | "antigravity" | "grok";
export type ApiKeyCredentials = { api_key: string; base_url?: string };
export type AccountCredentials = OAuthCredentials | ApiKeyCredentials;

export type OAuthCredentials = {
  access_token: string;
  refresh_token?: string;
  client_id?: string;
  expires_at?: string | number;
  chatgpt_account_id?: string;
};

export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_VERSION = "0.146.0";
export const CODEX_ORIGINATOR = "codex-tui";
export const CODEX_USER_AGENT =
  `${CODEX_ORIGINATOR}/${CODEX_VERSION} (Ubuntu 22.4.0; x86_64) xterm-256color`;

const UNSUPPORTED_FIELDS = [
  "max_output_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "chat_template_kwargs",
  "user",
  "metadata",
  "prompt_cache_retention",
  "safety_identifier",
  "stream_options",
  "truncation",
  "stop_sequences",
] as const;

export function expiresAtMillis(
  value: OAuthCredentials["expires_at"],
): number | undefined {
  if (typeof value === "number") {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function shouldRefresh(
  credentials: OAuthCredentials,
  now = Date.now(),
): boolean {
  const expiresAt = expiresAtMillis(credentials.expires_at);
  return Boolean(
    credentials.refresh_token && expiresAt && expiresAt <= now + 180_000,
  );
}

export async function refreshCredentials(
  credentials: OAuthCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthCredentials> {
  if (!credentials.refresh_token) {
    throw new Error("OAuth 凭据缺少 refresh_token");
  }

  const response = await fetchImpl(CODEX_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": CODEX_USER_AGENT,
      originator: CODEX_ORIGINATOR,
    },
    signal: AbortSignal.timeout(20_000),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refresh_token,
      client_id: credentials.client_id || CODEX_CLIENT_ID,
      scope: "openid profile email",
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI OAuth 刷新失败 (${response.status})`);
  }
  const token = JSON.parse(text) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (
    typeof token.access_token !== "string" || !token.access_token.trim() ||
    (token.refresh_token !== undefined &&
      (typeof token.refresh_token !== "string" ||
        !token.refresh_token.trim())) ||
    (token.expires_in !== undefined &&
      (!Number.isFinite(token.expires_in) || token.expires_in <= 0))
  ) {
    throw new Error("Invalid OpenAI OAuth refresh response");
  }

  return {
    ...credentials,
    access_token: token.access_token,
    refresh_token: token.refresh_token || credentials.refresh_token,
    expires_at: Date.now() + Math.max(60, token.expires_in ?? 3600) * 1000,
  };
}

export function normalizeBody(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("请求体必须是 JSON 对象");
  }
  const body = structuredClone(input) as Record<string, unknown>;
  for (const field of UNSUPPORTED_FIELDS) delete body[field];

  if (typeof body.input === "string") {
    body.input = [{ type: "message", role: "user", content: body.input }];
  } else if (!Array.isArray(body.input) && Array.isArray(body.messages)) {
    body.input = body.messages;
  }
  delete body.messages;

  if (!body.model || !body.input) {
    throw new Error("请求体必须包含 model 和 input");
  }
  if (
    typeof body.model !== "string" || !body.model.trim() ||
    body.model.length > 200 ||
    !Array.isArray(body.input) || !body.input.length ||
    (body.instructions !== undefined && typeof body.instructions !== "string")
  ) {
    throw new Error("Invalid Responses request");
  }
  body.instructions ??= "";
  body.store = false;
  body.stream = true;
  return body;
}

export function modelListFromManifest(input: unknown) {
  if (
    !input || typeof input !== "object" ||
    !Array.isArray((input as { models?: unknown }).models)
  ) {
    throw new Error("Invalid upstream model catalog");
  }
  const seen = new Set<string>();
  const models = (input as { models: unknown[] }).models;
  const data = models.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("Invalid upstream model entry");
    }
    const model = entry as { slug?: unknown; display_name?: unknown };
    if (typeof model.slug !== "string" || !model.slug.trim()) {
      throw new Error("Invalid upstream model id");
    }
    const id = model.slug.trim();
    if (seen.has(id) || id.includes("*")) return null;
    seen.add(id);
    return {
      id,
      object: "model",
      created: 0,
      owned_by: "openai",
      ...(typeof model.display_name === "string"
        ? { display_name: model.display_name }
        : {}),
    };
  }).filter((model) => model !== null);
  return { object: "list", data };
}

export function buildHeaders(credentials: OAuthCredentials): Headers {
  const headers = new Headers({
    authorization: `Bearer ${credentials.access_token}`,
    accept: "text/event-stream",
    "content-type": "application/json",
    "openai-beta": "responses=experimental",
    originator: CODEX_ORIGINATOR,
    version: CODEX_VERSION,
    "user-agent": CODEX_USER_AGENT,
  });
  if (credentials.chatgpt_account_id) {
    headers.set("chatgpt-account-id", credentials.chatgpt_account_id);
  }
  return headers;
}
