// Public clients authenticate with explicit API keys, never ambient cookies.
export function corsPreflight(request: Request): Response | undefined {
  if (request.method !== 'OPTIONS') return;
  const requested = request.headers.get('access-control-request-headers') ?? 'authorization,content-type';
  const headers = new Headers({
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,HEAD,POST,PATCH,DELETE,OPTIONS',
    'access-control-max-age': '600',
    'cache-control': 'no-store',
    'vary': 'Access-Control-Request-Headers',
  });
  // Explicit names are necessary for Authorization; a wildcard is insufficient.
  if (/^[a-zA-Z0-9!#$%&'*+.^_`|~ ,\-]+$/.test(requested)) headers.set('access-control-allow-headers', requested);
  return new Response(null, { status: 204, headers });
}

export function corsResponse(response: Response): Response {
  // Preserve the runtime-owned WebSocket upgrade response.
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-expose-headers', 'x-request-id,retry-after');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
