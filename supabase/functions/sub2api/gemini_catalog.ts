type Model = Record<string, unknown>;
import mappingRules from './antigravity_mapping.json' with {type:'json'};
import {filterModelCatalog,type ModelAllowlist} from './model_policy.ts';
export type GeminiCatalogSources = {has_antigravity:boolean;sources:Record<string,string>[]};
export function effectiveAntigravityMapping(raw: Record<string,string>): Record<string,string> {
  if (!Object.keys(raw).length) return {...mappingRules.defaults};
  const result = {...raw};
  const covered = (id:string) => Object.keys(result).some(pattern=>pattern===id||pattern.endsWith('*')&&id.startsWith(pattern.slice(0,-1)));
  for (const [id,target] of Object.entries(mappingRules.supplemental)) if (!covered(id)) result[id]=target;
  const target=result['gemini-pro-agent']?.trim();
  if(target) for(const id of ['gemini-3.1-pro','gemini-3.1-pro-high','gemini-3.1-pro-preview']) {
    if(Object.hasOwn(result,id)) {
      if(result[id]===id||id==='gemini-3.1-pro-preview'&&result[id]==='gemini-3.1-pro-high')result[id]=target;
    } else if(!covered(id))result[id]=target;
  }
  return result;
}
export function antigravityGeminiModels(sources:GeminiCatalogSources):Model[] {
  const ids=new Set(sources.sources.flatMap(mapping=>Object.keys(effectiveAntigravityMapping(mapping))).filter(id=>id.trim().startsWith('gemini-')));
  return [...ids].sort().map(geminiFallbackModel);
}
export function antigravityOnlyCatalog(sources:GeminiCatalogSources,allowlist?:ModelAllowlist,model?:string):Response|undefined {
  if(model&&sources.has_antigravity)return Response.json(filterModelCatalog(allowlist,geminiFallbackModel(model),true));
  const models=antigravityGeminiModels(sources);
  if(!model&&models.length)return Response.json(filterModelCatalog(allowlist,{models}));
}
// Pinned to backend/internal/pkg/gemini/models.go.
export const GEMINI_FALLBACK_IDS = [
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-image-preview',
  'gemini-3.1-flash-lite-image',
  'gemini-3-pro-image',
  'gemini-3-pro-image-preview',
  'gemini-3-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-customtools',
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  'gemini-4-argon',
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
