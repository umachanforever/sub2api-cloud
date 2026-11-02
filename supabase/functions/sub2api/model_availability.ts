import { HttpError } from "./db.ts";

type Entry = Record<string, any>;
type Result = { available: boolean; until: number };
type Probe = (request: Request, path: string) => Promise<Response>;

// Kept per handler and credential scope. Only completed inference proves availability.
export class ModelAvailability {
  private results = new Map<string, Result>();
  private pending = new Map<string, Promise<boolean>>();
  private now: () => number;
  constructor(now = Date.now) {
    this.now = now;
  }

  private async check(
    key: string,
    request: Request,
    path: string,
    probe: Probe,
    canceled: AbortSignal,
  ): Promise<boolean> {
    const cached = this.results.get(key);
    if (cached && cached.until > this.now()) return cached.available;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const work = (async () => {
      let available = false, ttl = 15_000;
      try {
        const response = await probe(request, path);
        if (response.ok) {
          const value = await response.json();
          available = !value?.error &&
            (path.startsWith("/v1beta/")
              ? Array.isArray(value?.candidates) && value.candidates.length > 0
              : Array.isArray(value?.choices) && value.choices.length > 0);
          ttl = available ? 10 * 60_000 : 60_000;
        } else {
          ttl = [400, 404, 405, 410, 422, 501].includes(response.status)
            ? 5 * 60_000
            : 15_000;
          await response.body?.cancel();
        }
      } catch (error) {
        if (
          error instanceof HttpError &&
          [400, 404, 405, 410, 422, 501].includes(error.status)
        ) ttl = 5 * 60_000;
      }
      // Client cancellation and the listing deadline must not poison later requests.
      if (!canceled.aborted) {
        if (this.results.size >= 1000) {
          this.results.delete(this.results.keys().next().value!);
        }
        this.results.set(key, { available, until: this.now() + ttl });
      }
      return available;
    })();
    this.pending.set(key, work);
    try {
      return await work;
    } finally {
      this.pending.delete(key);
    }
  }

  async filter(
    response: Response,
    request: Request,
    scope: string,
    native: boolean,
    probe: Probe,
  ): Promise<Response> {
    if (!response.ok || response.status === 204) return response;
    const body = await response.clone().json().catch(() => null);
    const field = Array.isArray(body?.data)
      ? "data"
      : Array.isArray(body?.models)
      ? "models"
      : undefined;
    if (!field) return response;
    const entries = body[field] as Entry[];
    const id = (entry: Entry) =>
      String(entry?.id ?? entry?.name ?? entry?.slug ?? "").replace(
        /^models\//,
        "",
      );
    // The native Gemini endpoint may advertise Claude models and arbitrary
    // aliases through Antigravity. Every entry must prove it works over the
    // advertised protocol, regardless of its model-name prefix.
    const requiresVerification = (entry: Entry) =>
      native ||
      id(entry).startsWith("gemini-") ||
      ["google", "gemini", "antigravity"].includes(entry?.owned_by);
    // Verify Gemini names first so slow foreign aliases cannot consume the
    // listing's entire verification budget before reaching Gemini models.
    const candidates = entries.filter(requiresVerification).sort((a, b) =>
      Number(id(b).startsWith("gemini-")) - Number(id(a).startsWith("gemini-"))
    );
    if (!candidates.length) return response;
    const available = new Set<Entry>();
    let next = 0;
    const deadline = AbortSignal.timeout(45_000);
    const canceled = AbortSignal.any([request.signal, deadline]);
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (next < candidates.length) {
        const entry = candidates[next++], model = id(entry);
        if (request.signal.aborted || deadline.aborted) break;
        if (!/^[a-zA-Z0-9._-]+$/.test(model)) continue;
        const path = native
          ? `/v1beta/models/${encodeURIComponent(model)}:generateContent`
          : "/v1/chat/completions";
        const headers = new Headers(request.headers);
        headers.delete("content-length");
        headers.delete("if-none-match");
        headers.delete("if-modified-since");
        headers.set("content-type", "application/json");
        const payload = native
          ? {
            contents: [{ role: "user", parts: [{ text: "Reply OK." }] }],
            generationConfig: { maxOutputTokens: 8 },
          }
          : {
            model,
            messages: [{ role: "user", content: "Reply OK." }],
            max_tokens: 8,
            stream: false,
          };
        const signal = AbortSignal.any([
          request.signal,
          deadline,
          AbortSignal.timeout(10_000),
        ]);
        const probeRequest = new Request(new URL(path, request.url), {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          signal,
        });
        const fingerprint = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify([scope, native, entry])),
        );
        const key = Array.from(
          new Uint8Array(fingerprint),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        if (await this.check(key, probeRequest, path, probe, canceled)) {
          available.add(entry);
        }
      }
    }));
    if (request.signal.aborted) throw request.signal.reason;
    await response.body?.cancel();
    const headers = new Headers(response.headers);
    for (
      const name of [
        "content-length",
        "content-encoding",
        "etag",
        "last-modified",
      ]
    ) headers.delete(name);
    headers.set("cache-control", "no-store");
    headers.set("content-type", "application/json");
    return new Response(
      JSON.stringify({
        ...body,
        [field]: entries.filter((entry) =>
          !requiresVerification(entry) || available.has(entry)
        ),
      }),
      { status: response.status, headers },
    );
  }
}
