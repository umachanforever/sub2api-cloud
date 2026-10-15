# sub2api-supabase

**Supabase deployment**

[English](README.md) | [Chinese README](README.zh-CN.md)

An AI API gateway for developers: connect OpenAI, Anthropic, Gemini, and other supported provider accounts to a unified API with account pooling, API key management, and usage tracking. When the gateway is deployed in an environment that can access its upstream providers and is directly reachable from mainland China, clients can use it without a VPN or proxy. Actual availability depends on the deployment location and ingress network.

The primary use case is a personal cloud gateway. Authentication, provider requests, credential refresh, and usage collection run on Supabase. The local Go backend and Vue console manage configuration and display cloud records; they do not need to stay online for AI requests. Commercial billing is outside the core request path.

## Why Use Supabase

The main goal is to let developers deploy the core backend to the cloud for free and with minimal effort: use PostgreSQL, Auth, and Edge Functions within Supabase's free-tier quotas, and directly use the HTTPS URL provided by the platform, reducing the cost of separately renting a server, purchasing a domain name, and running proxy software. The frontend console can run locally, while model requests are sent directly to the cloud API, so the local Supabase stack does not need to remain running.

Free deployment is subject to the database, request, bandwidth, and function execution limits of Supabase's current plans. Not all workloads are guaranteed to be free. Model API or subscription account fees are charged separately; higher quotas, custom domains, or additional network proxies may still incur costs. Proxy-free access from mainland China depends on whether the cloud endpoint is directly reachable and whether the server can access upstream services. Supabase itself does not guarantee these network conditions.

Based on [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api), this repository retains the original Vue console and the pinned Go backend in `backend/`. The architecture keeps Go administration local and the TypeScript AI gateway on Supabase; see [Architecture](docs/ARCHITECTURE.md) for the shared data contract. The existing startup commands run the Edge backend and Vue console.

The original Go management backend provides account, key, group, usage, announcement, and audit workflows. Supabase Auth owns identity sessions, and the TypeScript Edge gateway handles provider requests, streaming, and cloud jobs. The license is LGPL-3.0-or-later; see [NOTICE](NOTICE) for attribution.

The repository is designed for independent GitHub distribution. The Edge gateway uses its runtime import map; the Vue console uses its existing dependency lockfile. The release toolchain requires Node.js 24+, Go (the version required by `backend/go.mod`), Deno 2, the Supabase CLI, and Docker.

See the current [Supabase pricing](https://supabase.com/pricing) and [Edge Function limits](https://supabase.com/docs/guides/functions/limits) before choosing a plan.

## One-Command Startup

Install Node.js 24+, Go (the version required by `backend/go.mod`), the Supabase CLI, and Docker. Run the following commands from the repository root:

Local mode runs the Supabase containers and builds the Vue console. Allocate at least 6 GB of memory to Docker for a smooth local deployment.

```sh
cp .env.example .env.local
# Cloud mode: provide the Supabase URL, public key, service role, database password, and CLI account token
npm run up -- --cloud

# Local mode: no Supabase cloud account is required; local Supabase images are downloaded on first run
npm run up -- --local
```

Alternatively, set `SUPABASE_MODE=cloud` or `local` in `.env.local`, then run `npm run up`. The cloud entry point applies migrations, deploys functions, and starts the Docker console; the local entry point starts local Supabase, applies migrations, creates the initial administrator, and starts the console and Edge Functions. Both modes use http://127.0.0.1:3000. On first startup, missing credential encryption keys and the administrator password are generated automatically; existing keys are preserved.

Cloud administrator configuration is stored in `.env.local`, while local administrator configuration is stored in `.local/admin.json`; passwords are not printed to the terminal. You can set `SUB2API_LOCAL_ADMIN_EMAIL` before startup; the default is `admin@sub2api.local`. In local mode, keep the startup terminal running; to stop it, run `npm run down -- --local` in another terminal. To stop the cloud console, run `npm run down -- --cloud`. Stopping does not delete database data. Switching modes does not copy data or accounts; upstream credentials must be imported separately.

The keys and database used in local mode are independent of those in the cloud, and the CLI does not link or push to a cloud project. Existing cloud user and administrator UUIDs are preserved; for new projects, the startup script creates the initial administrator. `SUB2API_ADMIN_USER_IDS` initializes administrator roles once; subsequent role changes are managed in the console and stored in PostgreSQL.

### Switching to Cloud Deployment

When using cloud-hosted Supabase, stop the local Supabase instance to release local resources, then start the cloud console:

```sh
npm run down -- --local
npm run up -- --cloud
```

If the local startup terminal is still running, press Ctrl+C to terminate the function service process. Stopping preserves the local database volume and `.local/` credentials and does not affect the cloud database; do not use the option that deletes volumes. Cloud mode requires only the local console container and does not require local Supabase containers.

## Implemented

- Supabase Auth user sessions and database-managed administrator roles.
- Supabase email registration, password recovery, password changes, and native TOTP protection.
- Administrator-managed group creation/deactivation, member authorization, encrypted account import, and account deactivation.
- Multi-account priority and least-recently-used scheduling, per-key and per-account concurrency limits, and transactional database reservations.
- Per-user API key issuance, digest-only storage, expiration, revocation, and group isolation.
- Per-key request rate limiting, upstream error cooldowns, and limited account failover.
- OpenAI OAuth PKCE authorization flow, idempotent authorization tickets, reauthorization, persistent refresh, cross-instance refresh locking, and retry on 401 responses.
- Responses API SSE / explicit non-streaming mode, text-based Chat Completions conversion, Codex manifest, and per-call token usage records.
- Native proxying for official OpenAI, Anthropic, and Gemini API keys; user profile/password management and administrator user management.
- Announcement publishing/reading with AND/OR balance and active-subscription targeting, audit logging for business data and native Auth user/TOTP factor changes, and audit-log cleanup requiring fresh TOTP verification.

The frontend source code includes the original Vue console. OpenAI OAuth authorization, Supabase TOTP, provider API keys, usage dashboards, administration, announcements, and audit workflows are integrated. Tools are executed by the caller; the gateway preserves the caller's instructions and tool definitions without injecting additional permission instructions.

## Architecture and Directories

Browser → local Vue console / Node API proxy → Supabase Auth and the `subscription-api` Edge Function → PostgreSQL / official upstream model providers. Docker serves the frontend static files and proxy, while the database, core API, and credential refresh remain on Supabase. Configuration determines whether to use cloud-hosted Supabase or a local Supabase instance. Local mode still requires network access to upstream model providers.

| Directory | Contents |
| --- | --- |
| `frontend/` | Vue console pinned to a specific upstream version, with project-specific adaptations |
| `supabase/functions/subscription-api/` | Core TypeScript gateway and administrative API |
| `supabase/migrations/` | PostgreSQL schema, permissions, scheduling, and auditing |
| `scripts/` | Local proxy, static file serving, deployment, and credential import |
| `tests/` | Automated project verification |
| `docs/` | Deployment, architecture, legal, and upstream reference documentation |

## Cloud Project Configuration

Node.js 24+, Go (the version required by `backend/go.mod`), pnpm 10, Deno 2, the Supabase CLI, and Docker are required for the release toolchain. First, create a separate project in Supabase, then run the following commands from the repository root:

```sh
cp .env.example .env.local
chmod 600 .env.local
openssl rand -base64 32
```

Manually edit `.env.local`: set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (the public publishable/anon key), the legacy `SUPABASE_SERVICE_ROLE_KEY` JWT, and `SUB2API_ADMIN_USER_IDS` (administrator Auth UUIDs). Set `GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64` to the generated key and back it up securely. Deployment also requires `SUPABASE_DB_PASSWORD`; `SUPABASE_ACCESS_TOKEN` may be omitted if you run `supabase login` first. Do not commit `.env.local` or credential files.

The Docker console requires only the URL and public key. The service role, account token, database password, and encryption key are for backend or local administration tools only and must not be passed to the browser or console container. The generated encryption key is used to decrypt stored credentials; if it is lost, they cannot be recovered. Replacing it does not automatically re-encrypt existing data.

## Local Upstream Frontend

`frontend/` directly retains the upstream Vue pages, components, internationalization, and assets; no separate console is implemented. See NOTICE for the source and scope of modifications. Start both processes from this directory in separate terminals:

```sh
pnpm --dir frontend --ignore-workspace install --frozen-lockfile --registry=https://registry.npmjs.org
npm run console       # Terminal 1: local API proxy, 127.0.0.1:4173
npm run frontend      # Terminal 2: upstream Vite frontend, 127.0.0.1:3000
```

Open http://127.0.0.1:3000. Before a project is configured, you can view the upstream login page; attempting to sign in will clearly report that configuration is missing. After creating a new Supabase project, add `SUPABASE_PUBLISHABLE_KEY` (the public publishable/anon key) to `.env.local`, then restart the API proxy. The proxy uses only the project URL and public key; administrator privileges are verified against PostgreSQL on every management request. The browser neither needs nor supports configuring a service role key.

The Compose service uses the fixed container name `sub2api-supabase-console` and image tag `sub2api-supabase-console:latest`.

Currently supported: Supabase email/password sign-in, session refresh/sign-out, user information, authorization groups, key pagination/creation/renaming/expiration/revocation, user and administrator request logs, daily or hourly trends and model statistics, and administrator group and account lists. The full key is displayed once in a dialog only when it is created; the list shows only its prefix. Wallet balances, subscription quotas, token costs, and provider-reported cache usage are available in the console. Usage settlements retain the pricing snapshot and billing source; missing provider token counts remain null. Registration supports invitation codes, email-domain rules and primary-domain registration quotas, default credit and subscriptions, and promotional codes with usage limits. Dates are aggregated in Beijing time.

Basic account/group creation, querying, core-field editing, and deactivation in the upstream frontend have been adapted. Account status is independent of scheduling participation. Automatic exclusion upon expiration, per-account scheduling toggles, and basic bulk editing of up to 100 accounts are supported, with results returned for each item. For API Key accounts, a new key and basic settings can be saved atomically from the upstream edit page; active requests prevent key rotation. Member authorization is also available through the API below. UUID values are passed through as strings throughout the supported workflows.

Build output is written to `frontend/dist`, not to the original Go backend directory. `pnpm preview` provides only a static preview and does not provide the development proxy. Currently, use the Vite development server or the Docker-integrated static server described below. Both the frontend and proxy bind to loopback addresses.

## Deploy to Supabase

Creating a separate Supabase project is recommended. The migrations in this directory are not upgrade scripts for the original Sub2API or the primary application database and must not be applied directly to an existing service.

1. In Supabase Console Auth, create an administrator user and record the user's UUID. Disable public sign-ups if needed; create other users through Supabase Auth as well.
2. Edit `.env.local` and enter the project URL, public key, service role key, and administrator UUID. Keep the generated encryption key unchanged. See above for the initial configuration after cloning.
3. Set `SUPABASE_DB_PASSWORD` and `SUPABASE_ACCESS_TOKEN` in `.env.local` (or run `supabase login` first), then run:

```sh
npm run deploy
```

Supabase injects `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the cloud environment. The configuration disables platform JWT verification; inside the function, Auth JWTs are verified for administrative endpoints, while the function's own API keys are verified for model endpoints. Do not remove this authentication logic.

The function base URL is: `https://YOUR_PROJECT_REF.supabase.co/functions/v1/subscription-api`. The public `/health` endpoint only checks whether the process is running; it does not check account status or upstream connectivity.

You can run `deno task dev` locally on port 8000 by default, using the project database configured in `.env.local`. It writes to that database, so use a separate development project.

## Initial Configuration

In the following examples, set `GATEWAY_URL` to the function base URL. `ADMIN_JWT` is the administrator's Supabase Auth access token, **not the service role key or a model API key**. You can obtain it through the standard Supabase Auth sign-in endpoint:

```sh
curl "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"YOUR_EMAIL","password":"YOUR_PASSWORD"}'
```

Do not put passwords in scripts that may be committed; all values in the examples are placeholders. Variables set in the shell must be populated manually; `.env.local` is not automatically loaded into the current shell.

Create a group and record the returned `id` as `GROUP_ID`:

```sh
curl "$GATEWAY_URL/api/v1/admin/groups" \
  -H "Authorization: Bearer $ADMIN_JWT" -H "Content-Type: application/json" \
  -d '{"name":"OpenAI"}'
```

Grant a user access to the group. When a group is created through the creation endpoint, the creator is automatically granted membership; other users must still be granted access:

```sh
curl -X PUT "$GATEWAY_URL/api/v1/admin/groups/$GROUP_ID/members/$USER_ID" \
  -H "Authorization: Bearer $ADMIN_JWT"
```

Prepare your existing OAuth credentials in `account.credentials.json`:

```json
{
  "access_token": "YOUR_ACCESS_TOKEN",
  "refresh_token": "YOUR_REFRESH_TOKEN",
  "chatgpt_account_id": "YOUR_ACCOUNT_ID",
  "expires_at": "2030-01-01T00:00:00Z"
}
```

Enter the actual expiration time; do not copy the example date. `expires_at` supports Unix seconds, milliseconds, and ISO dates, and may also be omitted (the token will be refreshed after a 401 response); `client_id` is optional. The console provides an OpenAI OAuth authorization wizard; importing a file is an alternative method and does not automatically read credentials from other applications.

```sh
npm run credentials:import -- "$GROUP_ID" /absolute/path/to/account.credentials.json "Primary"
```

The importer encrypts the credentials and inserts them into the accounts table without overwriting existing accounts. The same ChatGPT account ID cannot be imported more than once; an account can route requests through multiple groups. After import, token refreshing should be handled exclusively by this service. The same refresh token should no longer be provided to Sub2API, Codex, or other clients for rotation.

Users can create an API key with their own Supabase Auth access token (`USER_JWT` below):

```sh
curl "$GATEWAY_URL/api/v1/keys" \
  -H "Authorization: Bearer $USER_JWT" -H "Content-Type: application/json" \
  -d "{\"name\":\"CLI\",\"group_id\":\"$GROUP_ID\"}"
```

The `key` in the response is returned only once. The defaults are 60 requests per minute and a maximum of 3 concurrent requests; regular users cannot create keys with limits higher than either of these values. Limits are currently calculated independently for each key.

## Call the Model

Set the newly created key as `API_KEY`, then select a model available to the account from the model catalog:

```sh
curl "$GATEWAY_URL/v1/models" -H "Authorization: Bearer $API_KEY"

curl -N "$GATEWAY_URL/v1/responses" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"MODEL_FROM_CATALOG","input":"Reply with hello","stream":true}'
```

The base URL for Responses clients is `$GATEWAY_URL/v1`. When OpenAI OAuth requests are sent upstream, the gateway uses `stream:true` and `store:false`, and removes sampling and output-length parameters unsupported by Codex. With explicit `stream:false`, the gateway aggregates the response into JSON; omitting `stream` preserves SSE. The gateway provides text, image, and tool conversion for `/v1/chat/completions`, as well as request, response, and SSE conversion from `/v1/messages` to OpenAI Responses. API Key accounts use the fixed native protocol of the official provider.

Requests are sent to fixed official Codex, OpenAI, Anthropic, or Gemini upstream services according to the account type; custom upstream URLs are not accepted. Client request bodies are limited to 1 MiB, and the entire model invocation and streaming output are subject to a 120-second timeout, as well as the runtime limits of the actual Supabase plan.

## Management API

All paths are prefixed with the function base URL. The management/user APIs use Supabase Auth JWTs, while the model APIs use this project's API keys. Browser CORS configuration and static page hosting are not provided.

| Method | Path | Authorization / Behavior |
| --- | --- | --- |
| GET | `/health` | No authentication required; indicates that the process is alive |
| GET | `/api/v1/user/profile` | Current user |
| GET | `/api/v1/groups/available` | Active groups the user is authorized to access |
| GET / POST | `/api/v1/keys` | List / create the user's own keys |
| PATCH | `/api/v1/keys/:id` | Modify `name`, `rpm`, `concurrency`, and `expires_at` for the user's own key |
| DELETE | `/api/v1/keys/:id` | Tombstone the key; history is retained and the key cannot be re-enabled |
| GET | `/api/v1/usage/dashboard?days=7` | The user's request count, aggregate known token usage, and trends |
| GET | `/api/v1/usage?limit=50` | The user's request records, up to 100 entries |
| GET / POST | `/api/v1/admin/groups` | Admin: list / create groups |
| PATCH | `/api/v1/admin/groups/:id` | Disable a group with `{ "enabled": false }` |
| PUT / DELETE | `/api/v1/admin/groups/:id/members/:user_id` | Admin: grant / revoke group access |
| GET / POST | `/api/v1/admin/accounts` | Admin: list / create provider accounts |
| GET / POST | `/api/v1/admin/accounts/data` | Admin: export / restore account backups |
| GET | `/api/v1/admin/accounts/:id/models` | Admin: available account models with display metadata |
| PATCH | `/api/v1/admin/accounts/:id` | Modify `name`, `status`, `priority`, and `concurrency` |
| GET | `/api/v1/admin/usage?limit=50` | Admin: view all request records |
| GET | `/v1/models` | Model catalog; consumes one request reservation |
| POST | `/v1/responses` | SSE or explicitly non-streaming JSON |
| POST | `/v1/chat/completions` | Text and tool calls, streaming or non-streaming |
| POST | `/v1/messages` | Native Anthropic API key protocol |
| POST | `/v1beta/models/:model:generateContent` / `:streamGenerateContent` | Native Gemini API key protocol |
| GET / POST | `/api/v1/admin/users` | User management, administrator roles, custom attributes and group filters |
| GET / PUT / DELETE | `/api/v1/admin/users/:id` | Retrieve, update/ban, or permanently delete the selected Auth user |
| GET / POST | `/api/v1/admin/announcements` | List and publish announcements |
| GET | `/api/v1/admin/audit-logs` | Audit logs for core business tables |

The JSON fields for creating an account are `name`, `platform`, `type`, and `credentials`, with optional `group_ids`, `priority`, and `concurrency`. API-key accounts use `{ "api_key": "YOUR_PROVIDER_KEY" }`; OpenAI OAuth accounts use the import credential format. Disable an account with `{ "status": "disabled" }`. Revoking a key, removing group membership, or disabling a group only prevents new reservations; it does not terminate streams that have already started.

Accounts can be stored without group bindings and become schedulable after assignment to a group. Creating an account without explicit groups uses the active `<platform>-default` group when available; `skip_default_group_bind` keeps it unbound. An empty `group_ids` array clears all bindings.

Account model mappings support exact names and trailing wildcards. Nonempty mappings restrict the models an account can serve and rewrite the upstream and billing model. Reservations preserve the mapping and price snapshot; usage records retain the requested, billing, and upstream models.

Administrator account backups include plaintext provider credentials, model mappings, and scheduling metadata. Keep backup files private. The console restores these backups with per-record results and encrypted credential storage. Restores keep accounts unbound by default; set `skip_default_group_bind` to `false` to use active provider default groups. Import requests accept up to 1 MiB and 1,000 account records. An `Idempotency-Key` identifies retries for two hours; when omitted, the canonical request fingerprint supplies the key. A reused key with a different payload returns a conflict. Existing account identities are never overwritten.

Account listings expose model mappings without returning encrypted credential data; key listings do not return keys or digests. Records include every account attempt, with retries linked by `request_id`; unknown token counts are `null`. Completed requests settle costs and quotas atomically with their usage records.

## Local Docker Console

Deploy the Supabase backend first and complete `.env.local`. Run the following commands from the repository root. If Vite is already using port 3000, stop Vite first or use the alternate port:

```sh
docker compose --env-file .env.local up --build -d
# If a service is already using port 3000:
CONSOLE_PORT=4300 docker compose --env-file .env.local up --build -d
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) (use port 4300 when using the alternate port). The browser and proxy use the same port; the container listens on port 4173, and the host publishes it only on the loopback interface. The proxy accepts requests only from localhost / 127.0.0.1 origins. Deployment with a public domain or remote browser is not currently supported.

```sh
docker compose --env-file .env.local logs --tail=100 console
docker compose --env-file .env.local down
```

The build context includes only the frontend, proxy, legal documents referenced by the frontend, and licenses; `.env.local`, Git history, backend source code, and local credentials are not included in the image. Compose injects only the deployment mode, URLs, and public keys into the container; it does not mount the environment file. The container runs as a non-root user, uses a read-only filesystem, and has additional capabilities disabled. The Docker commands provide the local console and proxy. Deploy the Edge Function and apply database migrations with `npm run deploy` before starting the console.

## Usage and Billing

Usage records and dashboard totals share filters for groups, accounts, API keys, models, request type, streaming, and billing source. User views remain scoped to the authenticated user; administrators can also select users. `billing_type` distinguishes wallet (`0`) and subscription (`1`) funding, while `billing_mode` identifies the pricing unit.

Token pricing uses USD rates from the bundled model catalog, including cache discounts, long-context tiers and priority or flex service tiers. For standard groups, group multipliers determine the amount charged to a user wallet. API key quotas are monetary limits; `token_quota` is a separate optional token limit. Each completed usage settlement records its price snapshot, costs and wallet ledger entry in one transaction. A request requires available credit; any debt from a larger final provider charge must be repaid before another paid request. Unrecognized models return `model_pricing_unavailable`.

## Redeem Codes

Administrators can generate balance and concurrency codes, including signed adjustments, and manage their expiry, status and notes. Redemption applies the entitlement and consumes the code in one transaction. Fixed-code fulfillment supports retries without issuing duplicate credit. User history includes redemption and administrator balance adjustments; internal code notes stay private. Redeemed codes retain their redemption state and cannot be deleted or reactivated through the administration API.

## Contributing and Security Reports

Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting. Use the GitHub issue templates for bug reports and feature requests. For security issues, follow [SECURITY.md](SECURITY.md), and do not disclose access tokens or production credentials.

## Project Name and Origin

The project name is sub2api-supabase. The default interface, logo, title, and welcome text use this project name. Supabase is the deployment platform; this project is not an official Supabase product. License and upstream copyright attributions are retained in LICENSE, COPYING, and NOTICE. Deployed cloud functions continue to use the `subscription-api` path, so existing calls do not need to be modified.

### Subscription plans

Subscription groups provide daily, weekly, and monthly USD quotas. Administrators can assign, renew, shorten, revoke, restore, and reset subscriptions from the original console. Subscription usage is charged against plan quotas; standard groups use the wallet balance. Bulk actions and fixed-order subscription redemptions support safe retries.

### Custom pages

Administration APIs and custom navigation are provided by the original Go management service. Set `MANAGEMENT_URL` to its local HTTP endpoint; model requests continue to use Supabase Edge Functions.

### OpenAI subscription quotas

The account console displays live quota windows, credit balances, and reset-card expirations. Manual resets support durable retries. Optional automatic resets use independent five-hour and seven-day thresholds, select the earliest-expiring card, and resume uncertain operations with the same card and redemption ID. Supabase runs the scheduler independently of the local console. See [OpenAI quota cards](docs/DEPLOYMENT.md#openai-quota-cards) for configuration and recovery behavior.

### Operations email

Configure SMTP and its sender in the console’s general settings, or set `RESEND_API_KEY` and `SUB2API_MAIL_FROM` in `.env.local` with a sender verified by Resend. SMTP takes priority, and its password is encrypted in private storage. Configure alert recipients, severity, batching, hourly limits, and daily or weekly reports in the console's operations settings. Supabase stores the queue and delivery state and runs the workers automatically. See [deployment instructions](docs/DEPLOYMENT.md#operations-email-delivery) for scheduling and retry behavior.

### Realtime operations

The console supports authenticated QPS/TPS WebSocket streams through the local proxy or Supabase Edge directly, with deployment-wide connection leases, session revalidation, and automatic reconnects. See [deployment instructions](docs/DEPLOYMENT.md#realtime-operations-websocket).

### Proxy management

Manage HTTP, HTTPS, SOCKS5, and SOCKS5h proxy records in the original administration console, including encrypted passwords, filtered lists, batch operations, expiration and backup settings, and measured connection tests. See [deployment instructions](docs/DEPLOYMENT.md#proxy-registry).

Account proxy bindings cover provider requests, OAuth token operations, model discovery, privacy settings, and OpenAI quota queries. Expired proxies follow configured backup or direct-connection rules, with manual restoration from the account console.
