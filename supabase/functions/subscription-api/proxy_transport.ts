import { isIP } from "node:net";

export type TransportProxy = { protocol: string; host: string; port: number; username: string; password: string };
export async function fetchWithProxy(proxy: TransportProxy, input: RequestInfo | URL, init: RequestInit = {},
  fetchImpl: typeof fetch = fetch, createClient = (options: Deno.CreateHttpClientOptions) => Deno.createHttpClient(options)) {
  const host = proxy.host.includes(":") ? `[${proxy.host}]` : proxy.host;
  const client = createClient({ proxy: { url: `${proxy.protocol}://${host}:${proxy.port}`,
    ...(proxy.username ? { basicAuth: { username: proxy.username, password: proxy.password } } : {}) } });
  let closed = false;
  const close = () => { if (!closed) { closed = true; client.close(); } };
  try {
    const response = await fetchImpl(input, { ...init, client } as RequestInit);
    if (!response.body) { close(); return response; }
    const reader = response.body.getReader();
    // Keep the native proxy client alive until streamed output is consumed or cancelled.
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try { const { done, value } = await reader.read(); if (done) { close(); controller.close(); } else controller.enqueue(value); }
        catch (error) { close(); controller.error(error); }
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { close(); } },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) { close(); throw error; }
}
export async function probeProxy(proxy: TransportProxy, signal: AbortSignal, send = fetchWithProxy) {
  const started = Date.now();
  try {
    const response = await send(proxy, "http://ip-api.com/json/?lang=en", { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), headers: { accept: "application/json" } });
    if (!response.ok) { await response.body?.cancel(); throw new Error(); }
    const reader = response.body?.getReader();
    let text = "";
    if (reader) try {
      while (true) { const { done, value } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); if (text.length > 16384) throw new Error(); }
    } finally { await reader.cancel(); }
    const value = JSON.parse(text);
    if (value.status !== "success" || typeof value.query !== "string" || !isIP(value.query)) throw new Error();
    const result: Record<string, unknown> = { success: true, message: "Proxy is accessible", latency_ms: Date.now() - started, ip_address: value.query };
    for (const [field, source] of Object.entries({ city: "city", region: "regionName", country: "country", country_code: "countryCode" })) if (typeof value[source] === "string" && value[source].length <= 254 && !/[\x00-\x1f\x7f]/.test(value[source])) result[field] = value[source];
    return result;
  } catch { return { success: false, message: "Proxy connectivity check failed" }; }
}
