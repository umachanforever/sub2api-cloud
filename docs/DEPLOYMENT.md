# Supabase Deployment

## Services

Supabase hosts PostgreSQL, Auth, and the `sub2api` Edge Function. Docker Compose hosts the original Go management service, its Redis cache, and the Vue console on the local workstation. The AI endpoint has no dependency on those local services.

The console is available at `http://127.0.0.1:3000`; the Go management endpoint binds to `127.0.0.1:8080`. Override `CONSOLE_PORT` and `MANAGEMENT_PORT` in `.env.local` if needed.

## Cloud setup

1. Create a Supabase project.
2. Copy `.env.example` to `.env.local` and fill the project URL, public key, service-role JWT, database password, and Management API access token.
3. Set the administrator email. Supply existing Auth UUIDs through `SUB2API_ADMIN_USER_IDS`, or leave it blank to create the administrator automatically.
4. Run `npm run up -- --cloud`.
5. Sign in to the local console, add a provider account, bind its provider group, and create an API key.

The startup command provisions the `s2a_management` database role using the Supabase Management API. This role owns the Go business schema and cannot administer the project. Management connects through the Supabase session pooler with TLS. Its generated password and service keys are saved in `.local/management-cloud.json`; the selected runtime configuration is written to `.local/management.env`.

The deployment applies `deploy/management-role.sql`, the original Go migrations, `deploy/account-vault.sql`, `deploy/gateway-proxy.sql`, and `deploy/personal-gateway.sql`. It then deploys the Edge Function with `SUB2API_DATA_MODEL=native`. Repeating startup preserves existing credentials, accounts, keys, and identity mappings.

Configure Supabase Auth's Site URL and allowed Redirect URLs for the local console. The default callback and recovery URLs are `http://127.0.0.1:3000/auth/callback` and `http://127.0.0.1:3000/reset-password`. Use the configured console port when changing these URLs.

## Local setup

Run `npm run up -- --local` to start the local Supabase stack and a separate management database. Local mode does not link or push to a cloud project. Its generated administrator credentials are saved in `.local/admin.json`, and management database credentials are saved in `.local/management-local.json`.

Keep the terminal open for the local Edge Function service. Use `npm run down -- --local` to stop the project while preserving its database volumes and local credentials.

When switching to cloud mode, local Supabase can remain stopped. Use `npm run down -- --cloud` to stop the local management services without affecting the deployed AI endpoint.

## Provider models and usage

Use the cloud `/v1/models` endpoint to discover the models available to the configured provider account. Account model mappings translate application-facing model names to supported upstream names. Changes made in the original account editor are visible to the cloud gateway through the same database records.

Cloud requests write provider-reported input, output, and cache token counts to the original `usage_logs` table. Missing provider values remain available as nulls in the request details. The personal request path writes zero monetary costs and does not debit balances or require subscriptions.

## Secrets and access

The browser and console proxy receive only the project URL and public key. The Go process receives its restricted database login and Supabase public authentication settings. Service-role and Management API credentials stay in deployment tooling and Supabase.

Provider credentials are encrypted with Supabase Vault. Cloud RPCs expose them only to the service role. Native business tables are not directly readable by browser roles or the service role; access is through authenticated management APIs and narrowly scoped cloud RPCs.

Keep `.env.local` and `.local/` private. Preserve them when moving the local management installation to another workstation.

## Image configuration

`GO_IMAGE` and `RUNTIME_IMAGE` select the management build and runtime images. Their defaults are `golang:1.27.2-alpine` and `postgres:18-alpine`. A reachable container registry mirror may be configured without changing the source.

## Cloud verification

After creating an agent key with `npm run agent:access`, run `npm run verify:cloud`. The command uses private `.local/agent-access.json` to verify health, rejected unauthenticated access, the configured model, ordinary and streaming Responses and Chat Completions, input-token preflight in both formats, and subscription usage. It sends four short inference requests and two preflight requests. The selected model must support these protocols. For OpenAI OAuth or personal-access-token accounts, run `npm run verify:cloud -- --codex` to also check the native Codex model manifest and one standalone web search with source URLs. These requests use the account's normal quota.

Verification connects directly to the configured gateway; it does not require the local console, Go service, or Redis. To verify workstation independence, stop local management with `npm run down -- --cloud` and run the command again. Start management again with `npm run up -- --cloud` when needed.

### Vertex batch image storage

Set `SUB2API_VERTEX_BATCH_BUCKET` to an existing Google Cloud Storage bucket name, without the `gs://` prefix. Grant the configured Vertex service account access to upload input objects, list and read result objects, and delete task objects. The bucket must meet Vertex AI's regional storage requirements.

`SUB2API_VERTEX_BATCH_LOCATION` selects the Vertex endpoint and defaults to `global`. `SUB2API_VERTEX_BATCH_ENVIRONMENT` defaults to `production` and separates managed objects under `batch-image/<environment>/<batch-id>/`. Keep these settings stable while jobs or retained outputs exist so polling and cleanup use the original storage location. Cloud deployment forwards these settings to the Edge Function. Leaving all three values empty clears the optional Vertex storage configuration.
