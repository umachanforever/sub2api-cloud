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

OpenAI API-key accounts support image generation through `/v1/images/generations` and `/images/generations`. Image options and JSON results are preserved; SSE accepts image frames up to 16 MiB, records provider-reported input/output tokens, and marks streams without a completion event as incomplete. Upstream errors remain sanitized.

OpenAI API-key accounts also accept Anthropic Messages requests through the Responses API. The bridge preserves system instructions, images, tool definitions and results, output limits, sampling options, and provider-reported usage. Clients receive Anthropic JSON or SSE according to their requested stream mode; upstream streaming is used for both modes.

The TypeScript gateway retains protocol-specific provider transports, model mappings, JSON and SSE response handling, tool definitions, and provider-reported usage. Model catalogs come from the selected account. Codex requests use one consistent client version for model discovery, User-Agent, and version headers. Administrator settings take precedence over the synchronized official stable version. A Supabase Cron job checks for stable updates every six hours, including when the local services are stopped. Request handling also checks for stale versions. Both paths respect the automatic synchronization setting, persists the result in shared settings, and retains the last known version when synchronization is unavailable. Provider credentials and network routes are resolved on the cloud side.

Antigravity's Gemini-native transport wraps requests in its internal project envelope and normalizes provider SSE into native Gemini events or an aggregated JSON response. Catalog requests use `fetchAvailableModels` and project only public model metadata. Dedicated Google client configuration and the shared Vault refresh lease keep Antigravity token refresh in the cloud; no provider credentials or project IDs are returned in catalogs or generation envelopes.

The original Go and Vue sources remain pinned and attributed as described in [NOTICE](../NOTICE).

Antigravity tool declarations normalize local schema definitions, object intersections, union branches, tuples, nullable types, and constants before forwarding. Unsupported constraints are retained as description hints. Expansion is bounded; unresolved, external, and recursive references return an explicit client error. Caller schemas, tool names, content, and thought signatures remain intact.

Claude Messages for Antigravity translate system instructions, base64 images/documents, signed thinking, tool calls/results, generation options, and custom tool declarations into the native request envelope. Stable sessions derive from the first user text unless caller metadata provides a session. Response conversion preserves thinking/tool signatures, emits ordered Claude SSE blocks, and maps cached input and reasoning output back into canonical usage. The `/antigravity` route enforces the selected account platform before provider dispatch.

Antigravity follows the original built-in tool selection: client function declarations take precedence over built-in search/code execution; search-only requests use `gemini-2.5-flash` with `requestType=web_search`. Usage records retain the actual provider model while client responses retain the requested alias. Claude responses include execution output and public search queries/sources, including metadata received after the final content event. Source URLs accept HTTP(S) without embedded credentials.

Grok text requests use native OpenAI-compatible Chat Completions and Responses. API keys default to `api.x.ai`; OAuth defaults to `cli-chat-proxy.grok.com`, with pinned upstream CLI headers. Only the official API, CLI, and three named regional origins accept credentials. Token rotation uses the shared Vault refresh lease, preserves the credential document, and retries an unauthorized request once after refresh. Provider-reported cached input is stored without subtracting it from total input. Incomplete provider responses map to the native database `interrupted` outcome, retaining observed usage and releasing the request lease.
