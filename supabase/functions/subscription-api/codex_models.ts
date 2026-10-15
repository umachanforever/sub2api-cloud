// Model spellings and reasoning constraints from the pinned Go OpenAI helpers.
export function modernCodexModel(model: string): { id: string; effort?: string } | undefined {
  const canonical = model.trim().split('/').at(-1)!.trim().toLowerCase()
    .replace(/[_\s]+/g, '-').replace(/-+/g, '-');
  for (const id of ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna']) {
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
