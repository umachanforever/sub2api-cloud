export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type Config = {
  url: string;
  serviceKey: string;
  jobSigningKey?: string;
  vertexBatch?: import("./batch_image_config.ts").VertexBatchConfig;
  encryptionKey: string;
  requestLimits?: import("./request_limits.ts").RequestLimits;
  adminIds: string[];
  dataModel?: "native";
  googleOAuth?: import("./google_oauth.ts").GoogleOAuthClients;
  mail?: { apiKey: string; from: string };
};

export class Database {
  readonly config: Config;
  readonly fetchImpl: typeof fetch;
  private readonly auditHeaders: Record<string, string>;
  constructor(config: Config, fetchImpl: typeof fetch = fetch, auditHeaders: Record<string, string> = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.auditHeaders = auditHeaders;
  }

  async rest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await this.fetchImpl(
      `${this.config.url}/rest/v1/${path}`,
      {
        method,
        headers: {
          ...this.auditHeaders,
          apikey: this.config.serviceKey,
          authorization: `Bearer ${this.config.serviceKey}`,
          "content-type": "application/json",
          prefer: "return=representation",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 409) throw new HttpError(409, "conflict");
      throw new HttpError(503, "database_unavailable");
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  rpc<T>(name: string, body: Record<string, unknown>): Promise<T> {
    return this.rest<T>(`rpc/${name}`, "POST", body);
  }

}
