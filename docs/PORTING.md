# Upstream Integration

sub2api-cloud is based on [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api), pinned to commit `9c2cca9e627291bc719bada3d57de23b625a4180`. The original Go backend and Vue console are retained in `backend/` and `frontend/`. License and attribution information is preserved in [NOTICE](../NOTICE).

The integration moves the AI request path to Supabase while retaining original management APIs locally. Both runtimes use the same native PostgreSQL business records. Supabase Auth supplies identity sessions; Supabase Vault encrypts provider credentials behind the original account JSON interface.

The TypeScript gateway implements cloud provider transports, streaming, model mapping, refresh coordination, and token usage persistence. Cloud request handling is independent of the local Go process and Redis. The original management service handles configuration and reads the resulting cloud records.

See [Architecture](ARCHITECTURE.md) for the runtime boundary and [Deployment](DEPLOYMENT.md) for provisioning and startup.
