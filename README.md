# sub2api-supabase

[English](README.md) | [简体中文](README.zh-CN.md)

A developer-friendly AI API gateway with a Supabase cloud backend and the original Sub2API management console. Connect OpenAI and Anthropic OAuth accounts and supported provider API keys, manage account pools and access keys, and inspect provider-reported token usage.

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

For Gemini CLI or Antigravity OAuth authorization, configure the corresponding `GEMINI_CLI_OAUTH_CLIENT_ID` / `GEMINI_CLI_OAUTH_CLIENT_SECRET` or `ANTIGRAVITY_OAUTH_CLIENT_ID` / `ANTIGRAVITY_OAUTH_CLIENT_SECRET` values in `.env.local`. Google OAuth clients are supplied at deployment time. Gemini also supports a custom OAuth client configured in the console.

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
