# Cloudflare API proxy

Create a Worker named `sub2api`, paste `worker.mjs` into its module editor,
and set the plaintext variable `SUPABASE_URL` to the project's HTTPS origin
(`https://<project-ref>.supabase.co`). No service-role key or provider credentials
belong in the Worker. Bind an unused custom hostname under **Domains**.
The default address is `https://sub2api.<account-subdomain>.workers.dev` when no
custom domain is available. Subsequent deployments can use the official CLI:
`npx wrangler deploy --config deploy/cloudflare/wrangler.jsonc --keep-vars`.
`--keep-vars` preserves the origin configured in the dashboard.

Clients use `https://<hostname>/v1` for OpenAI/Anthropic-compatible APIs and
`https://<hostname>/v1beta` for native Gemini. Existing full
`/functions/v1/sub2api/...` paths also work. API keys and authentication errors
are forwarded unchanged; Supabase remains the authentication boundary.

The proxy returns the upstream body as a stream, disables response caching,
and does not retry inference or follow upstream redirects. WebSocket upgrades
are returned unchanged. Do not add Cache Everything rules to this hostname or
log authorization headers, request bodies, or API keys in query parameters.
Cloudflare's plan and request-size limits still apply; this does not increase
Supabase's execution limits or guarantee connectivity from every network.

Verify `/health`, unauthorized `/v1/models`, authenticated model lists, and a
streamed chat completion before distributing the hostname. Run the local proxy
checks with `node --test tests/cloudflare-proxy.test.mjs`.
