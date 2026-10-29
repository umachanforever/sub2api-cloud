# Upstream Integration

sub2api-cloud is based on [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api), pinned to commit `dece26153621959ccd7635814f4b2d08304e681a` (v0.2.19). The original Go backend and Vue console are retained in `backend/` and `frontend/`. License and attribution information is preserved in [NOTICE](../NOTICE).

The integration moves the AI request path to Supabase while retaining original management APIs locally. Both runtimes use the same native PostgreSQL business records. Supabase Auth supplies identity sessions; Supabase Vault encrypts provider credentials behind the original account JSON interface.

The TypeScript gateway implements cloud provider transports, streaming, model mapping, refresh coordination, and token usage persistence. Cloud request handling is independent of the local Go process and Redis. The original management service handles configuration and reads the resulting cloud records.

See [Architecture](ARCHITECTURE.md) for the runtime boundary and [Deployment](DEPLOYMENT.md) for provisioning and startup.

## Upstream v0.2.19 synchronization

The vendored backend and console include the v0.2.19 changes, including Gemini 4 Argon routing, scoped administrator keys, and Gemini image group controls. Supabase identity, Vault credentials, gateway key admission, cloud media storage, and local console adaptations are retained. The product version remains 0.3.0; the Antigravity hub client identity retains the local 2.28.1 version. Provider catalogs, routing rules, and Go protocol converters are regenerated for the Edge Function. This source synchronization does not by itself expose every native management feature through the independent cloud implementation; see FULL_MIGRATION.md for runtime responsibilities.
