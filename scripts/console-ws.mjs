import {createHash} from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export function proxyWebsocket(request, socket, head, project) {
  const reject = status => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    const host = new URL(`http://${request.headers.host}`).hostname;
    const origin = request.headers.origin ? new URL(request.headers.origin) : null;
    if (!['127.0.0.1', 'localhost'].includes(host) || request.headers['sec-fetch-site'] === 'cross-site' ||
        origin && (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname))) return reject(403);
    const realtime=['/realtime','/v1/realtime'].includes(url.pathname);
    const responses=['/responses','/v1/responses','/backend-api/codex/responses'].includes(url.pathname),gateway=realtime||responses;
    if(responses&&url.search)return reject(400);
    if (request.method !== 'GET' || (!gateway && (url.pathname !== '/api/v1/admin/ops/ws/qps' || url.search)) || request.headers.upgrade?.toLowerCase() !== 'websocket') return reject(404);
    if(realtime&&([...url.searchParams.keys()].some(key=>key!=='model')||url.searchParams.getAll('model').length>1||url.search.length>300))return reject(400);
    if (!project) return reject(503);
    const target = new URL(gateway?project.supabase_url+'/functions/v1/sub2api'+(realtime?'/v1/realtime'+url.search:url.pathname):project.management_url + url.pathname);
    const headers = { connection: 'Upgrade', upgrade: 'websocket' };
    for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'authorization', 'origin', 'session-id', 'thread-id', 'x-codex-window-id', 'x-codex-installation-id', 'x-client-request-id', 'x-codex-beta-features']) if (request.headers[name]) headers[name] = request.headers[name];
    const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { headers, timeout: 10000 });
    let connected = false;
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (connected) socket.destroy(); else reject(502); });
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('response', response => { response.on('error', () => socket.destroy()); reject(response.statusCode || 502); response.resume(); });
    upstream.on('upgrade', (response, remote, remoteHead) => {
      const expected=createHash('sha1').update(String(request.headers['sec-websocket-key'])+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (response.statusCode !== 101 || (!gateway && response.headers['sec-websocket-protocol'] !== 'sub2api-admin') || gateway && response.headers['sec-websocket-protocol'] || response.headers['sec-websocket-accept']!==expected) { remote.destroy(); reject(502); return; }
      connected = true;remote.setTimeout(0);
      remote.on('error', () => socket.destroy());
      remote.on('close', () => socket.destroy());
      socket.on('close', () => remote.destroy());
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${response.headers['sec-websocket-accept']}\r\n${gateway?'':'Sec-WebSocket-Protocol: sub2api-admin\r\n'}\r\n`);
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      socket.pipe(remote).pipe(socket);
    });
    upstream.end();
  } catch { reject(400); }
}
