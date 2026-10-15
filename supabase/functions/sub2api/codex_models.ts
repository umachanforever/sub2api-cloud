// Unqualified Sol-era GPT versions default to the Sol variant.
export function defaultSolModel(model: string): string | undefined {
  const canonical = model.trim().split('/').at(-1)!.trim().toLowerCase().replace(/[_\s]+/g, '-').replace(/-+/g, '-');
  const match = /^gpt-(\d+)(?:\.\d+)*$/.exec(canonical);
  if (!match || (Number(match[1]) < 6 && canonical !== 'gpt-5.6')) return;
  return canonical + '-sol';
}

// Explicit variants retain their identity; reasoning constraints stay model-specific.
export function modernCodexModel(model: string): { id: string; effort?: string } | undefined {
  let canonical = model.trim().split('/').at(-1)!.trim().toLowerCase()
    .replace(/[_\s]+/g, '-').replace(/-+/g, '-');
  canonical = defaultSolModel(canonical) ?? canonical;
  const sol = /^(gpt-\d+(?:\.\d+)*-sol)(?:$|-)/.exec(canonical)?.[1];
  const future = sol && defaultSolModel(sol.slice(0, -4)) === sol ? [sol] : [];
  for (const id of new Set(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', ...future])) {
    if (canonical === id) return { id };
    if (!canonical.startsWith(id + '-')) continue;
    const suffix = canonical.slice(id.length + 1);
    if (suffix === 'openai-compact') return { id };
    const efforts = id === 'gpt-6.1-sol'
      ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
      : ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
    if (efforts.includes(suffix)) return { id, effort: suffix };
  }
}

export function validateCodexReasoning(body: Record<string, any>): void {
  const model = typeof body.model === 'string' ? modernCodexModel(body.model) : undefined;
  if (model?.id !== 'gpt-6.1-sol') return;
  const efforts = [model.effort, body.reasoning?.effort, body.reasoning_effort,
    body.output_config?.effort, body.thinking?.type === 'disabled' ? 'none' : undefined];
  if (efforts.some(effort => typeof effort === 'string' && ['none', 'minimal'].includes(effort.trim().toLowerCase()))) {
    throw new Error('gpt-6.1-sol requires reasoning effort low, medium, high, xhigh or max');
  }
}

export function supportsCodexMax(model: string): boolean {
  const canonical = model.trim().split('/').at(-1)!.toLowerCase().replace(/[_\s]+/g, '-');
  return !!modernCodexModel(model) || /^(?:gpt-6(?:-astra)?|gpt-5\.6(?:-(?:sol|terra|luna))?)(?:$|-(?:none|low|medium|high|xhigh|max|openai-compact)$)/.test(canonical);
}

// Responses reasoning mode and effort are independent for GPT-6. Sampling is
// available on Sol/Luna only with reasoning disabled, matching the Go gateway.
export function normalizeModernCodexResponses(body: Record<string, any>, canonicalModel = false): void {
  validateCodexReasoning(body);
  if (typeof body.model !== 'string') return;
  const model = modernCodexModel(body.model);
  if (!model) return;
  if (canonicalModel) body.model = model.id;
  if (model.id === 'gpt-6-astra') return;
  if (body.reasoning?.effort === 'none') return;
  for (const field of ['temperature', 'top_p', 'logprobs', 'top_logprobs']) delete body[field];
  if (Array.isArray(body.include)) body.include = body.include.filter((value: unknown) => value !== 'message.output_text.logprobs');
}
