type Entry = Record<string, any>;
const id = (entry: Entry) => String(entry?.id ?? entry?.name ?? entry?.slug ?? '').replace(/^models\//, '');

// Thinking effort is a request parameter. Keep provider families, preview/image
// releases and Claude thinking models distinct from these effort aliases.
export function thinkingBase(model: string): string | undefined {
  const match = /^(gemini-.+)-(?:low|medium|high|tiered)$/.exec(model)
    ?? /^(gpt-.+)-(?:none|minimal|low|medium|high|xhigh|max)$/.exec(model)
    ?? /^(claude-.+)-(?:low|medium|high|xhigh|max)$/.exec(model);
  return match?.[1];
}

// Only Antigravity may synthesize a Gemini base: its request dispatcher resolves
// bare names through the configured thinking variants, as in the original Go gateway.
export function supplementGeminiBases(entries: Entry[]): Entry[] {
  const names = new Set(entries.map(id)), extra: Entry[] = [];
  for (const entry of [...entries].sort((a,b)=>id(a).localeCompare(id(b)))) {
    const base = thinkingBase(id(entry));
    if (!base?.startsWith('gemini-') || names.has(base)) continue;
    const item = { ...entry };
    if (!('id' in item) && !('name' in item) && !('slug' in item)) continue;
    if ('id' in item) item.id = base;
    if (typeof item.name === 'string' && item.name.startsWith('models/')) item.name = 'models/' + base;
    if ('slug' in item) item.slug = base;
    for (const field of ['displayName', 'display_name', 'name']) {
      if (field === 'name' && 'name' in entry && String(entry.name).startsWith('models/')) continue;
      if (typeof item[field] === 'string') item[field] = item[field].replace(/(?:\s+|\s*\()(?:High|Medium|Low|Tiered)\)?$/i, '');
    }
    for (const field of ['thinkingBudget', 'defaultReasoningLevel', 'default_reasoning_level', 'default_reasoning_effort']) delete item[field];
    names.add(base); extra.push(item);
  }
  return extra.length ? [...entries, ...extra] : entries;
}

export function canonicalModelCatalog(value: Entry, permitsBase: (model: string) => boolean): Entry {
  const field = Array.isArray(value.data) ? 'data' : Array.isArray(value.models) ? 'models' : undefined;
  if (!field) return value;
  const entries = value[field] as Entry[], names = new Set(entries.map(id));
  const filtered = entries.filter(entry => {
    const base = thinkingBase(id(entry));
    return !base || !names.has(base) || !permitsBase(base);
  });
  return filtered.length === entries.length ? value : { ...value, [field]: filtered };
}

// Identical labels alone do not prove equivalence. Hide a legacy alias only
// when its actual mapping target is present, directly usable and permitted.
export function deduplicateMappedModels(value: Entry, resolveTarget: (model: string) => string | undefined, permitsModel: (model: string) => boolean): Entry {
  const field = Array.isArray(value.data) ? 'data' : Array.isArray(value.models) ? 'models' : undefined;
  if (!field) return value;
  const entries = value[field] as Entry[], names = new Set(entries.map(id)), seen = new Set<string>();
  const targetOf = (model: string) => resolveTarget(model)?.trim().replace(/^models\//, '') ?? model;
  const filtered = entries.filter(entry => {
    const model = id(entry);
    if (seen.has(model)) return false;
    seen.add(model);
    const target = targetOf(model);
    return target === model || !names.has(target) || !permitsModel(target) || targetOf(target) !== target;
  });
  return filtered.length === entries.length ? value : { ...value, [field]: filtered };
}
