export default {
  async fetch(request, env) {
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(env.SUPABASE_URL ?? '')) {
      return Response.json({ error: 'invalid_proxy_configuration' }, { status: 503, headers: { 'cache-control': 'no-store' } });
    }
    const incoming = new URL(request.url);
    const target = new URL(env.SUPABASE_URL);
    const prefix = '/functions/v1/sub2api';
    target.pathname = incoming.pathname === prefix || incoming.pathname.startsWith(prefix + '/')
      ? incoming.pathname : prefix + incoming.pathname;
    target.search = incoming.search;
    const forwarded = new Request(target, request);
    forwarded.headers.delete('host');
    try {
      const upstream = await fetch(forwarded, { redirect: 'manual', cf: { cacheTtl: 0, cacheEverything: false } });
      if (upstream.status === 101) return upstream;
      const headers = new Headers(upstream.headers);
      headers.set('cache-control', 'no-store');
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
    } catch {
      return Response.json({ error: 'proxy_upstream_unavailable' }, { status: 502, headers: { 'cache-control': 'no-store' } });
    }
  },
};
