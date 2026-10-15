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
  await check('chat', api + '/chat/completions', post({ model: config.model, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false }), async response => {
    const value = await json(response);
    if (!value.choices?.some(choice => typeof choice.message?.content === 'string' && choice.message.content.trim())) throw Error('Chat returned no text');
  });
  await check('stream', api + '/chat/completions', post({ model: config.model, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: true }), async response => {
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
          if (value.error) throw Error('Stream returned an error event');
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
    const checks = await verifyCloud(config);
    console.log(`Cloud verification passed: ${checks.join(', ')}.`);
  } catch (error) {
    // Response bodies and credentials must never appear in deployment logs.
    console.error(`Cloud verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
