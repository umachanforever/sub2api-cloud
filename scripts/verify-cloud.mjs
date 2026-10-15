import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function verifyCloud(config, fetcher = fetch) {
  const base = new URL(config.base_url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw Error('Set a valid HTTP base_url without credentials, query, or fragment');
  if (!config.api_key || !config.model) throw Error('Configure api_key and model');
  const api = base.href.replace(/\/+$/, '');
  if (!api.endsWith('/v1')) throw Error('base_url must end in /v1');
  const results = [];
  async function check(name, path, init, inspect, authenticated = true) {
    const response = await fetcher(path, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { ...(authenticated ? { authorization: `Bearer ${config.api_key}` } : {}), ...init?.headers },
    });
    await inspect(response);
    results.push(name);
  }
  const ok = response => { if (!response.ok) throw Error(`HTTP ${response.status}`); };
  const json = async response => { ok(response); return await response.json(); };
  const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await check('health', api.slice(0, -3) + '/health', {}, async response => {
    if ((await json(response)).ok !== true) throw Error('Invalid health response');
  }, false);
  await check('authentication', api + '/models', {}, async response => {
    await response.body?.cancel();
    if (response.status !== 401) throw Error('Unauthenticated model catalog must return 401');
  }, false);
  await check('models', api + '/models', {}, async response => {
    const value = await json(response);
    if (!Array.isArray(value.data) || !value.data.some(row => row.id === config.model)) throw Error('Configured model is absent from the catalog');
  });
  const inspectCount = async (response, responses = false) => {
    const value = await json(response);
    if (!Number.isSafeInteger(value.input_tokens) || value.input_tokens <= 0 || responses && value.object !== 'response.input_tokens') throw Error('Invalid input token preflight response');
  };
  await check('responses-input-tokens', api + '/responses/input_tokens', post({ model: config.model, input: 'Hello world' }), response => inspectCount(response, true));
  await check('messages-input-tokens', api + '/messages/count_tokens', {
    ...post({ model: config.model, messages: [{ role: 'user', content: 'Hello world' }] }),
    headers: { 'content-type': 'application/json', 'x-api-key': config.api_key },
  }, response => inspectCount(response), false);
  if (config.verify_codex) {
    await check('codex-models', api.slice(0, -3) + '/backend-api/codex/models', {}, async response => {
      const value = await json(response);
      if (!Array.isArray(value.models) || !value.models.some(row => row.slug === (config.expected_model || config.model))) throw Error('Configured model is absent from the Codex manifest');
    });
    await check('codex-search', api + '/alpha/search', post({ model: config.model, id: crypto.randomUUID(), commands: { search_query: [{ q: 'OpenAI official website' }] }, settings: { search_context_size: 'low' } }), async response => {
      const value = await json(response);
      if (typeof value.output !== 'string' || !value.output.trim() || !Array.isArray(value.results) || !value.results.some(row => typeof row.url === 'string' && /^https?:\/\//.test(row.url))) throw Error('Standalone search returned no source-backed result');
    });
  }
  const expectedModel = config.expected_model || config.model;
  const inspectModel = value => { if (value.model !== expectedModel) throw Error('Returned model does not match the configured model'); };
  await check('responses', api + '/responses', post({ model: config.model, input: 'Reply with OK.', stream: false }), async response => {
    const value = await json(response);
    inspectModel(value);
    if (value.status !== 'completed' || !value.output?.some(item => item.content?.some(part => part.type === 'output_text' && part.text?.trim()))) throw Error('Responses returned no completed text');
  });
  await check('chat', api + '/chat/completions', post({ model: config.model, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false }), async response => {
    const value = await json(response);
    inspectModel(value);
    if (!value.choices?.some(choice => typeof choice.message?.content === 'string' && choice.message.content.trim())) throw Error('Chat returned no text');
  });
  for (const responses of [false, true]) await check(responses ? 'responses-stream' : 'stream', api + (responses ? '/responses' : '/chat/completions'), post({ model: config.model, ...(responses ? { input: 'Reply with OK.' } : { messages: [{ role: 'user', content: 'Reply with OK.' }] }), stream: true }), async response => {
    ok(response);
    if (!response.headers.get('content-type')?.includes('text/event-stream')) { await response.body?.cancel(); throw Error('Expected an SSE response'); }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '', size = 0, text = false, done = false, finish = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1024 * 1024) throw Error('Smoke response exceeded 1 MiB');
        buffer += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { done = true; continue; }
          const value = JSON.parse(data);
          if (value.error || ['error', 'response.failed', 'response.incomplete'].includes(value.type)) throw Error('Stream returned an error event');
          if (responses) {
            if (value.type === 'response.output_text.delta' && value.delta?.trim()) text = true;
            if (value.type === 'response.completed') {
              inspectModel(value.response);
              if (value.response.status !== 'completed') throw Error('Responses stream did not complete');
              done = true; finish = true;
            }
          } else if (value.model) inspectModel(value);
          for (const choice of value.choices ?? []) {
            if (choice.delta?.content) text = true;
            if (choice.finish_reason) finish = true;
          }
        }
      }
      if (!text || !finish || !done) throw Error('Stream did not deliver text and a complete terminal event');
    } finally { await reader.cancel().catch(() => {}); }
  });
  await check('usage', api + '/usage', {}, async response => {
    const value = await json(response);
    if (!Array.isArray(value.accounts)) throw Error('Invalid subscription usage response');
  });
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = JSON.parse(await readFile(new URL('../.local/agent-access.json', import.meta.url), 'utf8'));
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== "--codex")) throw Error("Usage: npm run verify:cloud -- [--codex]");
    const checks = await verifyCloud({ ...config, verify_codex: args.includes("--codex") || config.verify_codex === true });
    console.log(`Cloud verification passed: ${checks.join(', ')}.`);
  } catch (error) {
    // Response bodies and credentials must never appear in deployment logs.
    console.error(`Cloud verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
