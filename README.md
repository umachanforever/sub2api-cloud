# sub2api-supabase

[English](README.md) | [简体中文](README.zh-CN.md)

A developer-friendly AI API gateway with a Supabase cloud backend and the original Sub2API management console. Connect OpenAI, Anthropic, and Gemini OAuth accounts and supported provider API keys, manage account pools and access keys, and inspect provider-reported token usage.

Supabase runs API authentication, credential refresh, provider requests, streaming, and usage recording. The local Go service and Vue console manage the same cloud records. **AI requests continue working when the local management services are stopped.** Mini Program authentication remains separate.

Supabase's free tier and included HTTPS endpoint reduce the need for a separately rented server, domain, and local proxy software. Clients in mainland China can use the gateway without a VPN when the Supabase endpoint is directly reachable and its region can reach the upstream provider. Availability and free-tier capacity depend on the network and the current [Supabase plan](https://supabase.com/pricing).

## Deployment

Install Node.js 24+, Docker with Compose 2.24+, and the Supabase CLI.

```sh
cp .env.example .env.local
chmod 600 .env.local
# Fill the Supabase project settings in .env.local.
npm run up -- --cloud
```

Open http://127.0.0.1:3000. The command provisions the isolated management database role, applies the original Go schema and cloud gateway functions, connects the administrator's Supabase identity, deploys the Edge Function, and starts the local management services.

Required cloud settings:

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Public publishable or anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side service-role JWT |
| `SUPABASE_DB_PASSWORD` | Project database password used by the CLI |
| `SUPABASE_ACCESS_TOKEN` | Management API token used during provisioning |
| `SUB2API_LOCAL_ADMIN_EMAIL` | Administrator email |
| `SUB2API_ADMIN_USER_IDS` | Existing administrator Auth UUIDs, or leave blank for automatic creation |

Keep `SUB2API_DATA_MODEL=native`. Missing administrator passwords and credential encryption keys are generated and saved in `.env.local`. Private database credentials and local service keys are stored under `.local/`. These files are excluded from Git and never sent to the browser.

The console uses Supabase Auth. Account credentials are encrypted with Supabase Vault; API authentication and usage records use the original Go business tables. Commercial billing does not gate personal cloud requests or debit the user's balance.

For Gemini CLI or Antigravity OAuth authorization, configure the corresponding `GEMINI_CLI_OAUTH_CLIENT_ID` / `GEMINI_CLI_OAUTH_CLIENT_SECRET` or `ANTIGRAVITY_OAUTH_CLIENT_ID` / `ANTIGRAVITY_OAUTH_CLIENT_SECRET` values in `.env.local`. Google OAuth clients are supplied at deployment time.

Gemini OAuth supports AI Studio and Code Assist. Use `GEMINI_OAUTH_CLIENT_ID` / `GEMINI_OAUTH_CLIENT_SECRET` for a custom AI Studio client. The deployment command installs the Gemini client configuration in the cloud gateway as well as local management, so token refresh continues with the local services stopped. Code Assist accounts retain their project information in encrypted account credentials.

Antigravity OAuth accounts expose their provider model catalog and Gemini-native `generateContent` / `streamGenerateContent` routes, plus Claude Messages with JSON or SSE output. Claude clients can use the `/antigravity` base path with the same group-bound API key. Configure `ANTIGRAVITY_OAUTH_CLIENT_ID` and `ANTIGRAVITY_OAUTH_CLIENT_SECRET` for cloud refresh. The gateway retains the encrypted project ID, injects the upstream identity prompt while preserving caller instructions, unwraps internal response envelopes, and uses the provider's fixed daily and production endpoints for fallback.

## Local Supabase

```sh
npm run up -- --local
```

Local mode starts a separate Supabase stack and provisions its own management schema and administrator. No cloud account is required. Credentials are saved in `.local/admin.json`; keep the terminal running for the local Edge Function service. Local and cloud data remain separate.

```sh
npm run down -- --local
npm run up -- --cloud
```

Cloud mode needs only the local console, Go management service, and Redis when using the management interface. Local Supabase can stay stopped. Stopping all local containers also leaves the cloud AI endpoint available.

## API

Use the gateway endpoint displayed in the console:

```text
https://<project-ref>.supabase.co/functions/v1/subscription-api
```

Create a provider account, bind it to a matching provider group, and create an API key in the original console. Choose a model from `/v1/models`; account model mappings can preserve an application's existing model names.

```sh
export AI_BASE_URL='https://<project-ref>.supabase.co/functions/v1/subscription-api'
export AI_API_KEY='your-issued-api-key'
curl "$AI_BASE_URL/v1/models" -H "Authorization: Bearer $AI_API_KEY"
```

The gateway supports Responses, Chat Completions, Anthropic Messages, and Gemini API formats, with streaming and ordinary responses according to the selected provider and credential type.

### Subscription usage

`GET /v1/usage` returns the provider-reported five-hour and seven-day subscription windows for OpenAI OAuth accounts in the key's group. Authenticate with `Authorization: Bearer <api-key>`. Each account includes `five_hour` and `seven_day` objects with `used_percent`, `remaining_percent`, `window_seconds`, and `reset_at`. These are shared account allowances, rather than this key's token totals. Unsupported groups return an empty account list; missing window values are `null`.

Snapshots are reused for up to 60 seconds. Add `?refresh=true` to query the provider immediately, or `?account_id=<id>` to select an account. Inspect `fetched_at`, `age_seconds`, `cached`, and `stale`; provider failures return an explicit per-account `error` and mark retained snapshots stale.

```sh
curl "$AI_BASE_URL/v1/usage?refresh=true" -H "Authorization: Bearer $AI_API_KEY"
```

For full agent API access, run `npm run agent:access` while the local console is running. Configure the administrator credentials and an existing `GPT_SUBSCRIPTION_GATEWAY_KEY` in `.env.local`. The command creates a normal `sk-` API key in the same provider group and saves `base_url`, `api_key`, model, and usage URLs in private `.local/agent-access.json`. This key supports AI requests, model discovery, and usage queries, and can be managed in the console. Any previous usage-only token in `.local/agent-usage.json` is revoked and that configuration is updated.

Run `npm run verify:cloud` to check the deployed gateway using `.local/agent-access.json`. It verifies authentication, model discovery, ordinary and streaming Chat Completions, and usage without the local management services. The check makes two short AI requests.

For optional usage-only access, run `npm run usage:access`. This saves a private `.local/agent-usage.json`. The generated `sk-usage-` token can read usage but cannot make AI requests or access management APIs. It inherits the linked inference key's group, expiration, status, and IP restrictions. Revoke it by setting its `revoked_at` in `s2a_private.usage_tokens`; disabling or deleting the linked inference key also blocks it.

The console caches successful authenticated data queries in tab memory for 60 seconds, including dashboard, usage, account details, and settings. Writes and session changes invalidate snapshots. Authentication, OAuth flows, exports, and streams bypass this cache; a request with `Cache-Control: no-cache` forces a fresh read.

## Project layout

| Directory | Responsibility |
| --- | --- |
| `backend/` | Original Go management backend |
| `frontend/` | Original Vue console and cloud identity integration |
| `supabase/functions/subscription-api/` | Cloud AI request handling and provider transports |
| `supabase/migrations/` | Supabase project foundation |
| `deploy/` | Shared management schema access, Vault storage, and cloud RPCs |
| `scripts/` | Provisioning, deployment, and local console hosting |
| `tests/` | Gateway and management verification |
| `docs/` | Deployment, architecture, and upstream references |

See [Deployment](docs/DEPLOYMENT.md), [Architecture](docs/ARCHITECTURE.md), and [Contributing](CONTRIBUTING.md).

## License

Based on [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api). Licensed under LGPL-3.0-or-later. Upstream licenses and attribution are retained in [LICENSE](LICENSE), [COPYING](COPYING), and [NOTICE](NOTICE).
