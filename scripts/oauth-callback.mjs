import { createServer } from 'node:http';

// The authorization code stays in this browser tab; the console owns its PKCE exchange.
export function createOAuthCallbackServer() {
  return createServer((request,response) => {
    let url;
    try { url = new URL(request.url,'http://localhost:1455'); } catch { /* Reject malformed callback targets. */ }
    const accepted = /^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/i.test(request.headers.host ?? '') && request.method === 'GET' && url?.pathname === '/auth/callback';
    const complete = accepted && url.searchParams.get('code') && url.searchParams.get('state');
    response.writeHead(accepted ? complete ? 200 : 400 : 404, {
      'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer',
      'content-security-policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      'x-content-type-options':'nosniff',
    });
    response.end(`<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>sub2api-cloud · OAuth</title><h1>${complete?'授权已返回':'授权未完成'}</h1><p>${complete?'请复制浏览器地址，粘贴到控制台的授权回调输入框。完成后即可关闭此页。':'请返回控制台重新开始授权。'}</p></html>`);
  });
}
