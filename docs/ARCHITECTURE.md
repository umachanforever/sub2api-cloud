# Architecture

## Deployment boundary

| Component | Responsibility | Location |
| --- | --- | --- |
| Vue console | Original administration screens | Local Docker |
| Go backend | Original management APIs and administrative services | Local Docker |
| Redis | Management caches | Local Docker |
| Edge Function | API key validation, account selection, provider requests, streaming, refresh, and usage recording | Supabase |
| PostgreSQL | Authoritative accounts, groups, keys, credentials, and usage | Supabase |
| Auth | Console identity and sessions | Supabase |

The cloud AI endpoint never calls the workstation or local Redis. Stopping local management and local Supabase leaves cloud inference operational. Mini Program sign-in remains independent.

## Shared records

The original Go business schema is authoritative. Accounts, groups, API keys, and usage use native integer identifiers. Supabase identities map to Go users through `auth_identities`; roles and user status are resolved from the business database.

`deploy/management-role.sql` isolates ownership under `s2a_management` and removes default browser access. The management service uses this restricted database role through the session pooler. It does not receive the Supabase service-role JWT.

`deploy/account-vault.sql` retains Go's account JSON contract through an updateable view while encrypting the credential document with Supabase Vault. Credential versions and transactional refresh locks coordinate cloud refresh with management edits.

`deploy/personal-gateway.sql` provides service-only admission, completion, quota snapshot, and sanitized error RPCs. Admission resolves native key hashes, validates account and group status, applies IP and model policies, and reserves account capacity. Completion writes raw token usage into `usage_logs`; identical completion retries are idempotent.

Provider quota headers update canonical account metadata. Classified errors go to the original operations log table without request bodies, headers, or provider secrets. Management reads these cloud records directly.

The personal cloud request path does not use wallet charges, subscription settlement, or a monetary pricing engine. Original Go management features remain available in the console.

## Runtime ownership

Supabase owns provider requests and automatic OAuth refresh. Supabase identity mode disables native Go model and sign-in routes and prevents conflicting local gateway background workers from starting. Explicit account administration remains in Go.

The local Node service serves the Vue console, proxies management HTTP and WebSocket traffic to Go, and connects browser identity operations to Supabase Auth. It forwards AI traffic to the cloud endpoint when a local API URL is used.

## Provisioning

`scripts/management.mjs` installs the restricted role, native schema, Vault adapter, and gateway RPCs. It links configured administrator Auth identities without changing existing identity ownership. Cloud and local configurations use separate private credential files.

`scripts/deploy.mjs` provisions management before changing Edge secrets or deploying the native data adapter. `scripts/up.mjs` coordinates local and cloud modes and starts the management containers.

## Provider protocols

The TypeScript gateway retains protocol-specific provider transports, model mappings, JSON and SSE response handling, tool definitions, and provider-reported usage. Model catalogs come from the selected account. Provider credentials and network routes are resolved on the cloud side.

Antigravity's Gemini-native transport wraps requests in its internal project envelope and normalizes provider SSE into native Gemini events or an aggregated JSON response. Catalog requests use `fetchAvailableModels` and project only public model metadata. Dedicated Google client configuration and the shared Vault refresh lease keep Antigravity token refresh in the cloud; no provider credentials or project IDs are returned in catalogs or generation envelopes.

The original Go and Vue sources remain pinned and attributed as described in [NOTICE](../NOTICE).
