// Adapted from internal/pkg/antigravity request, response and stream transformers (LGPL-3.0-or-later).
import { HttpError } from './db.ts';
type Item = Record<string, any>;
function fail(): never { throw new HttpError(400, 'unsupported_messages_content'); }
const dummy = 'skip_thought_signature_validator';
const object = (value: unknown): value is Item => !!value && typeof value === 'object' && !Array.isArray(value);

export function antigravitySearchTool(tool: unknown): boolean {
  return object(tool) && (typeof tool.type === 'string' && (tool.type.startsWith('web_search') || tool.type === 'google_search') || ['web_search', 'google_search', 'web_search_20250305'].includes(typeof tool.name === 'string' ? tool.name.trim() : ''));
}
export function antigravitySearchOnly(body: Item): boolean {
  return Array.isArray(body.tools) && body.tools.some(antigravitySearchTool) && !body.tools.some((tool: unknown) => object(tool) && !antigravitySearchTool(tool) && tool.type !== 'code_execution' && typeof tool.name === 'string' && tool.name.trim());
}

export function claudeToAntigravity(body: Item): Item {
  if (!Array.isArray(body.messages) || !body.messages.length || typeof body.model !== 'string') fail();
  const names = new Map<string, string>(), system: Item[] = [], contents: Item[] = [];
  const gemini = body.model.startsWith('gemini-');
  const argon = /^gemini-4-argon(?:-|$)/.test(body.model);
  let stripped = false;
  const textParts = (value: unknown): Item[] => {
    if (typeof value === 'string') return value ? [{ text: value }] : [];
    if (!Array.isArray(value)) fail();
    return value.map(block => { if (!object(block) || block.type !== 'text' || typeof block.text !== 'string') fail(); return { text: block.text }; });
  };
  if (body.system !== undefined) system.push(...textParts(body.system));
  for (const message of body.messages) {
    if (!object(message) || !['user', 'assistant', 'system'].includes(message.role)) fail();
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    if (!Array.isArray(blocks)) fail();
    const parts: Item[] = [];
    for (const block of blocks) {
      if (!object(block)) fail();
      if (block.type === 'text' && typeof block.text === 'string') { if (block.text) parts.push({ text: block.text }); }
      else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        const signature = typeof block.signature === 'string' && block.signature && (gemini || block.signature !== dummy) ? block.signature : gemini ? dummy : undefined;
        if (signature) parts.push({ text: block.thinking, thought: true, thoughtSignature: signature });
        else { if (block.thinking) parts.push({ text: block.thinking }); stripped = true; }
      } else if (['image', 'document'].includes(block.type) && block.source?.type === 'base64' && typeof block.source.data === 'string' && typeof block.source.media_type === 'string') {
        parts.push({ inlineData: { mimeType: block.source.media_type, data: block.source.data } });
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && object(block.input)) {
        names.set(block.id, block.name);
        const signature = typeof block.signature === 'string' && block.signature && (gemini || block.signature !== dummy) ? block.signature : gemini ? dummy : undefined;
        parts.push({ functionCall: { id: block.id, name: block.name, args: structuredClone(block.input) }, ...(signature ? { thoughtSignature: signature } : {}) });
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        let result: string;
        if (block.content === undefined || block.content === '') result = block.is_error ? 'Tool execution failed with no output.' : 'Command executed successfully.';
        else if (typeof block.content === 'string') result = block.content;
        else if (Array.isArray(block.content)) result = textParts(block.content).map(part => part.text).join('\n');
        else fail();
        parts.push({ functionResponse: { id: block.tool_use_id, name: names.get(block.tool_use_id) ?? block.name ?? block.tool_use_id, response: { result } } });
      } else fail();
    }
    if (message.role === 'system') system.push(...parts);
    else if (parts.length) contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }
  if (!contents.length) fail();
  const generationConfig: Item = { maxOutputTokens: 64000 };
  if (body.max_tokens !== undefined) {
    if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1) throw new HttpError(400, 'invalid_max_tokens');
    generationConfig.maxOutputTokens = Math.min(body.max_tokens, gemini ? 65000 : 64000);
  }
  for (const [from, to] of [['temperature', 'temperature'], ['top_p', 'topP'], ['top_k', 'topK']]) if (body[from] !== undefined) {
    if (typeof body[from] !== 'number' || !Number.isFinite(body[from])) throw new HttpError(400, 'invalid_generation_config');
    if (!argon) generationConfig[to] = body[from];
  }
  if (body.stop_sequences !== undefined) {
    if (!Array.isArray(body.stop_sequences) || body.stop_sequences.some((s: unknown) => typeof s !== 'string')) fail();
    if (!argon) generationConfig.stopSequences = body.stop_sequences;
  }
  if (!stripped && ['enabled', 'adaptive'].includes(body.thinking?.type)) {
    let budget = body.thinking.budget_tokens ?? -1;
    if (!Number.isSafeInteger(budget) || budget === 0 || budget < -1) throw new HttpError(400, 'invalid_thinking_budget');
    if (body.thinking.type === 'adaptive' && /^claude-opus-4-[678]/.test(body.model)) budget = 24576;
    if (body.model.includes('gemini-2.5-flash')) budget = Math.min(budget, 24576);
    if (budget > 0) { budget = Math.min(budget, (gemini ? 65000 : 64000) - 1); generationConfig.maxOutputTokens = Math.max(generationConfig.maxOutputTokens, budget + 1); }
    generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: budget };
  }
  const declarations: Item[] = [];
  let search = false, code = false;
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) fail();
    for (const tool of body.tools) {
      if (antigravitySearchTool(tool)) { search = true; continue; }
      if (object(tool) && tool.type === 'code_execution') { code = true; continue; }
      if (!object(tool) || tool.type && tool.type !== 'custom' || typeof tool.name !== 'string') throw new HttpError(400, 'unsupported_messages_tool');
      const spec = tool.type === 'custom' ? tool.custom : tool;
      if (!object(spec)) throw new HttpError(400, 'unsupported_messages_tool');
      declarations.push({ name: tool.name, ...(typeof spec.description === 'string' ? { description: spec.description } : {}), parameters: structuredClone(spec.input_schema ?? { type: 'object' }) });
    }
  }
  const tools: Item[] = declarations.length ? [{ functionDeclarations: declarations }] : [...(search ? [{ googleSearch: { enhancedContent: { imageSearch: { maxResultCount: 5 } } } }] : []), ...(code ? [{ codeExecution: {} }] : [])];
  const functionCallingConfig: Item = { mode: 'VALIDATED' };
  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice;
    if (!object(choice) || !['auto', 'none', 'any', 'tool'].includes(choice.type)) fail();
    functionCallingConfig.mode = { auto: 'AUTO', none: 'NONE', any: 'ANY', tool: 'ANY' }[choice.type as string];
    if (choice.type === 'tool') {
      if (!declarations.some(tool => tool.name === choice.name)) fail();
      functionCallingConfig.allowedFunctionNames = [choice.name];
    }
  }
  return { contents, ...(system.length ? { systemInstruction: { role: 'user', parts: system } } : {}), generationConfig,
    toolConfig: { functionCallingConfig }, ...(tools.length ? { tools } : {}),
    ...(typeof body.metadata?.user_id === 'string' ? { sessionId: body.metadata.user_id } : {}) };
}

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function usage(value: Item): Item {
  const source = value.usageMetadata ?? {}, result: Item = {};
  if (count(source.cachedContentTokenCount)) result.cache_read_input_tokens = source.cachedContentTokenCount;
  if (count(source.promptTokenCount)) result.input_tokens = Math.max(0, source.promptTokenCount - (result.cache_read_input_tokens ?? 0));
  if (count(source.candidatesTokenCount)) result.output_tokens = source.candidatesTokenCount + (count(source.thoughtsTokenCount) ? source.thoughtsTokenCount : 0);
  return result;
}
function content(parts: Item[]): Item[] {
  const result: Item[] = [];
  for (const part of parts) {
    if (part.functionCall) result.push({ type: 'tool_use', id: part.functionCall.id || 'toolu_' + crypto.randomUUID(), name: part.functionCall.name, input: part.functionCall.args ?? {}, ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}) });
    else if (typeof part.text === 'string') result.push(part.thought ? { type: 'thinking', thinking: part.text, ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}) } : { type: 'text', text: part.text });
    if (part.executableCode && typeof part.executableCode.code === 'string') result.push({ type: 'text', text: `\n\n\`\`\`${String(part.executableCode.language ?? '').toLowerCase()}\n${part.executableCode.code}\n\`\`\`` });
    if (part.codeExecutionResult && typeof part.codeExecutionResult.output === 'string') result.push({ type: 'text', text: `\n\nExecution result (${part.codeExecutionResult.outcome ?? 'unknown'}):\n${part.codeExecutionResult.output}` });
    if (!part.thought && !part.functionCall && part.thoughtSignature) result.push({ type: 'thinking', thinking: '', signature: part.thoughtSignature });
  }
  const merged: Item[] = [];
  for (const block of result) {
    const prior = merged.at(-1);
    if (prior && prior.type === block.type && ['text', 'thinking'].includes(block.type)) {
      const field = block.type === 'text' ? 'text' : 'thinking';
      prior[field] += block[field];
      if (block.signature) prior.signature = block.signature;
    } else merged.push(block);
  }
  return merged;
}
export function groundingText(grounding: Item | undefined): string {
  if (!grounding) return '';
  const queries = Array.isArray(grounding.webSearchQueries) ? grounding.webSearchQueries.filter((q: unknown) => typeof q === 'string') : [];
  const links: string[] = [];
  for (const chunk of Array.isArray(grounding.groundingChunks) ? grounding.groundingChunks : []) {
    if (typeof chunk?.web?.uri !== 'string') continue;
    let url: URL;
    try { url = new URL(chunk.web.uri); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
    const title = String(chunk.web.title || 'Source').replace(/[\\\[\]<>]/g, (c: string) => c === '<' ? '&lt;' : c === '>' ? '&gt;' : '\\' + c);
    links.push(`[${links.length + 1}] [${title}](${url.href.replaceAll('(', '%28').replaceAll(')', '%29')})`);
  }
  return (queries.length ? '\n\n---\nWeb search queries: ' + queries.join(', ') : '') + (links.length ? '\n\nSources:\n' + links.join('\n') : '');
}
function reason(finish: string, tools: boolean) { return finish === 'MAX_TOKENS' ? 'max_tokens' : finish !== 'STOP' ? 'refusal' : tools ? 'tool_use' : 'end_turn'; }
export async function antigravityToClaude(response: Response, streaming: boolean, model: string): Promise<Response> {
  if (!response.ok) return response;
  const id = 'msg_' + crypto.randomUUID();
  if (!streaming) {
    const value = await response.json(), candidate = value.candidates?.[0];
    const blocks = content(candidate?.content?.parts ?? []);
    const sources = groundingText(candidate?.groundingMetadata);
    if (sources) blocks.push({ type: 'text', text: sources });
    if (!candidate?.finishReason && !value.promptFeedback?.blockReason) throw new HttpError(502, 'incomplete_upstream_response');
    return Response.json({ id, type: 'message', role: 'assistant', model, content: blocks, stop_reason: reason(candidate?.finishReason, blocks.some(block => block.type === 'tool_use')), stop_sequence: null, usage: usage(value) });
  }
  if (!response.body) throw new HttpError(502, 'invalid_upstream_stream');
  let pending = '', index = 0, started = false, terminal = '', tools = false, totals: Item = {};
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  let active = '';
  const grounding: Item = {};
  function close(controller: TransformStreamDefaultController<Uint8Array>) {
    if (active) { emit(controller, 'content_block_stop', { index }); index++; active = ''; }
  }
  function emit(controller: TransformStreamDefaultController<Uint8Array>, type: string, value: Item) { controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`)); }
  function frame(raw: string, controller: TransformStreamDefaultController<Uint8Array>) {
    const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const value = JSON.parse(data);
    if (value.error) throw new HttpError(502, 'invalid_upstream_event');
    totals = { ...totals, ...usage(value) };
    if (!started) { emit(controller, 'message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: totals } }); started = true; }
    const candidate = value.candidates?.[0];
    for (const key of ['webSearchQueries', 'groundingChunks']) if (!grounding[key]?.length && Array.isArray(candidate?.groundingMetadata?.[key])) grounding[key] = candidate.groundingMetadata[key];
    for (const block of content(candidate?.content?.parts ?? [])) {
      if (terminal) throw new HttpError(502, 'invalid_upstream_event');
      tools ||= block.type === 'tool_use';
      const initial = block.type === 'text' ? { type: 'text', text: '' } : block.type === 'thinking' ? { type: 'thinking', thinking: '' } : { ...block, input: {} };
      if (active !== block.type || block.type === 'tool_use') {
        close(controller);
        emit(controller, 'content_block_start', { index, content_block: initial });
        active = block.type;
      }
      emit(controller, 'content_block_delta', { index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : block.type === 'thinking' ? { type: 'thinking_delta', thinking: block.thinking } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
      if (block.type === 'thinking' && block.signature) emit(controller, 'content_block_delta', { index, delta: { type: 'signature_delta', signature: block.signature } });
      if (block.type === 'tool_use') close(controller);
    }
    if (candidate?.finishReason) terminal = candidate.finishReason;
    if (value.promptFeedback?.blockReason) terminal = 'SAFETY';
  }
  return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      pending += decoder.decode(bytes, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        if (boundary.index > 1048576) throw new HttpError(502, 'upstream_event_too_large');
        frame(pending.slice(0, boundary.index), controller); pending = pending.slice(boundary.index + boundary[0].length);
      }
      if (pending.length > 1048576) throw new HttpError(502, 'upstream_event_too_large');
    },
    flush(controller) {
      pending += decoder.decode(); if (pending.trim()) frame(pending, controller);
      if (!started || !terminal) throw new HttpError(502, 'incomplete_upstream_response');
      close(controller);
      const sources = groundingText(grounding);
      if (sources) {
        emit(controller, 'content_block_start', { index, content_block: { type: 'text', text: '' } });
        emit(controller, 'content_block_delta', { index, delta: { type: 'text_delta', text: sources } });
        emit(controller, 'content_block_stop', { index }); index++;
      }
      emit(controller, 'message_delta', { delta: { stop_reason: reason(terminal, tools), stop_sequence: null }, usage: totals });
      emit(controller, 'message_stop', {});
    },
  })), { status: response.status, headers: { 'content-type': 'text/event-stream' } });
}
