import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

export async function verifyWebSocket(config, signal) {
  const base = new URL(config.base_url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !base.pathname.replace(/\/+$/, '').endsWith('/v1')) throw Error('Configure an HTTP base_url ending in /v1 without credentials, query, or fragment');
  if (!config.api_key || typeof config.model !== 'string' || !config.model.trim()) throw Error('Configure api_key and model');
  base.pathname = base.pathname.replace(/\/+$/, '') + '/responses';
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  const code = 'WS-' + crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase();
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(base, { headers: { authorization: 'Bearer ' + config.api_key, 'session-id': crypto.randomUUID() }, handshakeTimeout: 25000 });
    let turns = 0, text = '', settled = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const fail = reason => {
      if (settled) return; settled = true; cleanup(); socket.terminate(); reject(Error('WebSocket verification failed: ' + reason));
    };
    const abort = () => fail('interrupted');
    const timer = setTimeout(() => fail('timed out'), 90000);
    socket.on('unexpected-response', (_request, response) => { response.resume(); fail('HTTP ' + response.statusCode); });
    socket.on('open', () => socket.send(JSON.stringify({ type: 'response.create', model: config.model, input: 'Remember this code and reply only with it: ' + code })));
    socket.on('message', bytes => {
      if (settled) return;
      let event; try { event = JSON.parse(bytes.toString()); } catch { fail('invalid JSON frame'); return; }
      if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') { fail('upstream did not complete the turn'); return; }
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') text += event.delta;
      if (event.type !== 'response.completed') return;
      const response = event.response;
      if (text.trim() !== code || typeof response?.id !== 'string' || !response.id || !Number.isSafeInteger(response.usage?.input_tokens) || response.usage.input_tokens <= 0) { fail('missing context, response identity, or input usage'); return; }
      turns++;
      if (turns === 1) {
        text = '';
        socket.send(JSON.stringify({ type: 'response.create', model: config.model, previous_response_id: response.id, input: 'Repeat the code from the previous turn. Reply only with that code.' }));
      } else {
        settled = true; cleanup(); socket.close(1000); resolve(['websocket', 'websocket-context', 'websocket-usage']);
      }
    });
    socket.on('error', () => fail('transport error'));
    socket.on('close', code => { if (!settled) fail(`closed after ${turns} completed turns (code ${code})`); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = JSON.parse(await readFile(new URL('../.local/agent-access.json', import.meta.url), 'utf8'));
    console.log('Cloud WebSocket verified: ' + (await verifyWebSocket(config)).join(', ') + '.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
