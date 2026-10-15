type Model = Record<string, unknown>;
// Pinned to backend/internal/pkg/gemini/models.go.
export const GEMINI_FALLBACK_IDS = [
  'gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-image', 'gemini-2.5-pro',
  'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3-pro-preview',
  'gemini-3.1-pro-preview', 'gemini-3.1-pro-preview-customtools', 'gemini-3.1-flash-image',
];
export function geminiFallbackModel(id: string): Model {
  return { name: id.startsWith('models/') ? id : 'models/' + (id || 'unknown'),
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] };
}
const object = (value: unknown): value is Model => !!value && typeof value === 'object' && !Array.isArray(value);

// Keep native metadata and pagination fields when supplementing provider catalogs.
export function mergeGeminiCatalog(body: string, extra: Model[]): string {
  let envelope: unknown;
  try { envelope = JSON.parse(body); } catch { return body; }
  if (!object(envelope) || !Array.isArray(envelope.models) || !envelope.models.every(object)) return body;
  const models = [...envelope.models];
  const names = new Set(models.map(model => model.name));
  for (const model of extra) {
    if (!names.has(model.name)) { models.push(model); names.add(model.name); }
  }
  return models.length === envelope.models.length ? body : JSON.stringify({ ...envelope, models });
}

// Authentication failures only permit fallback when the upstream reports missing scopes.
export function geminiCatalogScopeFallback(status: number, headers: Headers, body: string): boolean {
  return (status === 401 || status === 403) &&
    (headers.get('www-authenticate')?.toLowerCase().includes('insufficient_scope') === true ||
      /insufficient authentication scopes|access_token_scope_insufficient/i.test(body));
}

export async function fallbackGeminiCatalog(upstream: Response, path: string): Promise<Response> {
  if (upstream.ok || ![401, 403, 404].includes(upstream.status)) return upstream;
  const segment = /^\/v1beta\/models\/([^/]+)$/.exec(path)?.[1];
  const model = segment ? decodeURIComponent(segment) : undefined;
  // Unknown 404s remain errors; known preview models can be absent from AI Studio.
  const knownMissing = upstream.status === 404 && model !== undefined && GEMINI_FALLBACK_IDS.includes(model);
  let scoped = false;
  if (upstream.status !== 404) {
    const copy = upstream.clone();
    scoped = geminiCatalogScopeFallback(upstream.status, upstream.headers, await copy.text());
  }
  if (!knownMissing && !scoped) return upstream;
  await upstream.body?.cancel();
  return Response.json(model ? geminiFallbackModel(model) : { models: GEMINI_FALLBACK_IDS.map(geminiFallbackModel) });
}
