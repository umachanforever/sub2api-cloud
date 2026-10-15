# sub2api-cloud

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

Cloud settings:

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Public publishable or anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Optional override; retrieved automatically with the access token when blank |
| `SUPABASE_DB_PASSWORD` | Project database password used by the CLI |
| `SUPABASE_ACCESS_TOKEN` | Management API token used during provisioning |
| `SUB2API_LOCAL_ADMIN_EMAIL` | Administrator email |
| `SUB2API_ADMIN_USER_IDS` | Existing administrator Auth UUIDs, or leave blank for automatic creation |

Supabase generates the service-role key and injects it into hosted Edge Functions. Local provisioning retrieves the existing key using the Management API when the override is blank; it does not generate or rotate a key.

Keep `SUB2API_DATA_MODEL=native`. Missing administrator passwords and credential encryption keys are generated and saved in `.env.local`. Private database credentials and local service keys are stored under `.local/`. These files are excluded from Git and never sent to the browser.

The console uses Supabase Auth. Account credentials are encrypted with Supabase Vault; API authentication and usage records use the original Go business tables. Commercial billing does not gate personal cloud requests or debit the user's balance.

For Gemini CLI or Antigravity OAuth authorization, configure the corresponding `GEMINI_CLI_OAUTH_CLIENT_ID` / `GEMINI_CLI_OAUTH_CLIENT_SECRET` or `ANTIGRAVITY_OAUTH_CLIENT_ID` / `ANTIGRAVITY_OAUTH_CLIENT_SECRET` values in `.env.local`. Google OAuth clients are supplied at deployment time.

Gemini OAuth supports AI Studio and Code Assist. Use `GEMINI_OAUTH_CLIENT_ID` / `GEMINI_OAUTH_CLIENT_SECRET` for a custom AI Studio client. The deployment command installs the Gemini client configuration in the cloud gateway as well as local management, so token refresh continues with the local services stopped. Code Assist accounts retain their project information in encrypted account credentials.

Grok API-key and OAuth accounts support native Chat Completions, Responses, and model discovery with JSON or SSE output. OAuth requests use the official Grok CLI identity and refresh credentials in the cloud. Official xAI regional endpoints can be selected in account credentials.

Antigravity OAuth accounts expose their provider model catalog and Gemini-native `generateContent` / `streamGenerateContent` routes, plus Claude Messages with JSON or SSE output. Claude clients can use the `/antigravity` base path with the same group-bound API key. Configure `ANTIGRAVITY_OAUTH_CLIENT_ID` and `ANTIGRAVITY_OAUTH_CLIENT_SECRET` for cloud refresh. The gateway retains the encrypted project ID, injects the upstream identity prompt while preserving caller instructions, unwraps internal response envelopes, and uses the provider's fixed daily and production endpoints for fallback.

TypeSafe API-key accounts support `POST /v1/systemone` with the native `jev-latest` model and `noul`, `choice`, and `score` questions. Requests are non-streaming; provider JSON responses pass through unchanged, with a 4 MiB response limit. Model discovery uses the same group-bound key.

OpenAI groups also support native Responses WebSocket connections through `GET /v1/responses`, `/responses`, or `/backend-api/codex/responses`. Use a Bearer key in the upgrade request and send `response.create` JSON frames. Each turn rechecks access, records its own usage, and stays on the same provider account; `previous_response_id` continues the upstream conversation. A model change requires a new connection. The account’s WebSocket disable switch and `http_bridge` selection apply in the cloud. OpenAI `http_bridge` mode and Grok Responses WebSocket use HTTP streaming with in-connection conversation and tool-call history replay. Connections use the hosted gateway’s 120-second lifetime.

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
https://<project-ref>.supabase.co/functions/v1/sub2api
```

The gateway also accepts the upstream root aliases `/models`, `/models/:model`, `/chat/completions`, `/responses`, `/embeddings`, and `/images/generations` under the same function endpoint. Authentication, model policies, and usage recording are shared with the `/v1` routes.

Codex client identity follows the official stable release automatically. Supabase Cron checks every six hours, even when local services are stopped; request handling also refreshes stale versions. The console automatic synchronization switch controls both paths, and an explicit client version retains precedence. Model availability also depends on the upstream account.

Create a provider account, bind it to a matching provider group, and create an API key in the original console. Choose a model from `/v1/models`; account model mappings can preserve an application's existing model names.

```sh
export AI_BASE_URL='https://<project-ref>.supabase.co/functions/v1/sub2api'
export AI_API_KEY='your-issued-api-key'
curl "$AI_BASE_URL/v1/models" -H "Authorization: Bearer $AI_API_KEY"
```

The gateway supports Responses, Chat Completions, Anthropic Messages, and Gemini API formats, with streaming and ordinary responses according to the selected provider and credential type.

Gemini `cachedContent` references are scoped to their owning key and group and stay pinned to the account that created the cache. Unknown, expired, foreign, or model-mismatched cache names are rejected before provider dispatch.

`POST /v1beta/cachedContents` creates a cache through a Gemini API-key account, with model mapping, a default one-hour lifetime, a maximum 24-hour lifetime, and key/group/account ownership. Provider resources carry a unique creation tag; creation intents are retained before dispatch.
`GET /v1beta/cachedContents` lists active caches owned by the current key and group, with `pageSize` and `pageToken` pagination. `GET /v1beta/cachedContents/{id}` returns the public cache metadata without exposing provider resource names or account identifiers.
`DELETE /v1beta/cachedContents/{id}` deletes an owned cache through its bound API-key account and removes its local binding only after the provider confirms absence.
`PATCH /v1beta/cachedContents/{id}` updates `ttl` or `expireTime` (up to 24 hours), with immutable cache identity and serialized updates/deletions. Interrupted mutations retain ownership until recovery restores the recorded expiry on the bound provider; resources that are absent or expiring are removed.
Supabase runs cache mutation recovery every minute. Signed jobs reclaim expired mutation leases, restore the recorded provider expiry, and remove missing or expired resources without relying on the local console or an enabled client key.
The scheduled worker also cleans interrupted creations after their request leases expire. Provider pages stay private; cleanup matches the owning account, unique creation tag, and model. Pagination progress is persisted, and provider failures leave the intent pending for another attempt.

### Subscription usage

`GET /v1/usage` returns the provider-reported five-hour and seven-day subscription windows for OpenAI OAuth accounts in the key's group. Authenticate with `Authorization: Bearer <api-key>`. Each account includes `five_hour` and `seven_day` objects with `used_percent`, `remaining_percent`, `window_seconds`, and `reset_at`. These are shared account allowances, rather than this key's token totals. Unsupported groups return an empty account list; missing window values are `null`.

Snapshots are reused for up to 60 seconds. Add `?refresh=true` to query the provider immediately, or `?account_id=<id>` to select an account. Inspect `fetched_at`, `age_seconds`, `cached`, and `stale`; provider failures return an explicit per-account `error` and mark retained snapshots stale.

```sh
curl "$AI_BASE_URL/v1/usage?refresh=true" -H "Authorization: Bearer $AI_API_KEY"
```

For full agent API access, run `npm run agent:access` while the local console is running. Configure the administrator credentials and an existing `GPT_SUBSCRIPTION_GATEWAY_KEY` in `.env.local`. The command creates a normal `sk-` API key in the same provider group and saves `base_url`, `api_key`, model, and usage URLs in private `.local/agent-access.json`. This key supports AI requests, model discovery, and usage queries, and can be managed in the console. Any previous usage-only token in `.local/agent-usage.json` is revoked and that configuration is updated.

Run `npm run verify:cloud` to check the deployed gateway using `.local/agent-access.json`. It verifies authentication, model discovery, ordinary and streaming Responses and Chat Completions, returned model identity, Responses and Messages input-token preflight, and usage without the local management services. The check makes four short AI requests and two preflight requests. Add `-- --codex` to also verify the native Codex model manifest and a source-backed standalone web search.

Run `npm run verify:attachments` to verify PDF and image reading through Responses, Chat Completions, and Messages using `.local/agent-access.json`. It makes six AI requests, checks a random code embedded only in the PDF and the colors in a generated PNG, and requires reported input-token usage. Use a model and account with vision and PDF support.

Run `npm run verify:websocket` to verify two real Responses WebSocket turns, input-token usage, and context reuse through `previous_response_id`. The second turn must recover a random code from the first turn without receiving that code again. Add `-- --websocket` to `npm run verify:independence` to include this check while the local services are stopped. These checks use `.local/agent-access.json`; WebSocket verification makes two AI requests.

Run `npm run verify:schedulers` with `.env.local` to check the four cloud schedules and their actual signed HTTP delivery through `pg_net`. It requires `SUPABASE_ACCESS_TOKEN` and checks response status without reading request headers, secrets, or response bodies. The check triggers the existing workers, so queued work may be processed; HTTP acceptance does not establish provider inference success.

Run `npm run verify:storage` to verify the private Supabase artifact bucket using `.env.local`. It uploads a small temporary object, checks authenticated reads, denied public access, and a short-lived signed download, then deletes the object and verifies removal. It does not make AI requests.

Run `npm run verify:independence` to temporarily stop this project's local console, management service, and Redis, run the cloud checks, and restore the containers that were running. It checks container ownership first and restores services after a failed or interrupted verification. Other Docker projects are left running.

For optional usage-only access, run `npm run usage:access`. This saves a private `.local/agent-usage.json`. The generated `sk-usage-` token can read usage but cannot make AI requests or access management APIs. It inherits the linked inference key's group, expiration, status, and IP restrictions. Revoke it by setting its `revoked_at` in `s2a_private.usage_tokens`; disabling or deleting the linked inference key also blocks it.

Common data pages also retain their loaded UI state for 60 seconds when switching sections. Filters are isolated, inactive snapshots are invalidated after writes, and signing out clears retained pages. Live monitors and payment flows keep their normal lifecycle.

For a browser-ready, read-only URL, run `npm run usage:link` after creating agent access. The private `.local/usage-link.json` contains `browser_url`. It lists each enabled subscription account by name with separate five-hour and seven-day windows, scoped to the linked key’s group. Disabled accounts are excluded.

The console caches successful authenticated data queries in tab memory for 60 seconds, including dashboard, usage, account details, and settings. Writes and session changes invalidate snapshots. Authentication, OAuth flows, exports, and streams bypass this cache; a request with `Cache-Control: no-cache` forces a fresh read.

## Project layout

| Directory | Responsibility |
| --- | --- |
| `backend/` | Original Go management backend |
| `frontend/` | Original Vue console and cloud identity integration |
| `supabase/functions/sub2api/` | Cloud AI request handling and provider transports |
| `supabase/migrations/` | Supabase project foundation |
| `deploy/` | Shared management schema access, Vault storage, and cloud RPCs |
| `scripts/` | Provisioning, deployment, and local console hosting |
| `tests/` | Gateway and management verification |
| `docs/` | Deployment, architecture, and upstream references |

See [Deployment](docs/DEPLOYMENT.md), [Architecture](docs/ARCHITECTURE.md), and [Contributing](CONTRIBUTING.md).

Unqualified Sol-era GPT versions select the Sol variant: `gpt-6` → `gpt-6-sol`, `gpt-6.1` → `gpt-6.1-sol`, and future GPT versions follow the same rule. Explicit variants and account model mappings retain precedence. An alias requires its target model to be available upstream.

`GET /v1/sub2api/billing` returns the authenticated key’s configured token multipliers, including user overrides and peak-hour settings. It uses the inference key, enforces its IP policy, and does not reserve an account or generate billable usage.

OpenAI API-key accounts support `/v1/embeddings` (also `/embeddings`) with text or token batches, float or base64 vectors, model mapping, and input-token usage recording. This endpoint uses the text request body limit and does not support streaming. ChatGPT OAuth accounts do not provide an embeddings API key.

Chat Completions accepts inline file data and provider file IDs. The Messages-to-OpenAI bridge accepts base64 PDFs, document URLs, and plain text documents, including files in tool results. Document citations are supported only by providers that handle them natively; enabling citations through the OpenAI bridge returns an explicit error.

OpenAI accounts support `POST /v1/responses/input_tokens`, including `/responses/input_tokens` and `/backend-api/codex/responses/input_tokens` aliases. The gateway uses the provider preflight endpoint when available and falls back to the upstream tiktoken estimation approach inside the Edge Function when the endpoint is unsupported. Preflight counts do not create generation usage records or charge a balance. The fallback is an estimate, including for multimodal inputs.
Anthropic-format clients can use `POST /v1/messages/count_tokens` or `/messages/count_tokens` with Bearer or `x-api-key` authentication. OpenAI accounts use the Responses preflight bridge, Grok accounts use the local estimator, and Anthropic accounts use the native provider endpoint. These requests do not create generation usage records.

Gemini clients can use `POST /v1beta/models/{model}:countTokens` with Bearer, `x-goog-api-key`, or query-key authentication. The gateway supports native contents and nested generation requests, pins cached references to their owning account, and falls back to the native text estimator for transport failures, rate limits, server errors, or missing OAuth scopes. These counts do not create generation usage records.

Codex clients can discover the native model manifest at `GET /backend-api/codex/models`; OpenAI OAuth accounts return the Codex model metadata even without a `client_version` query.

`GET /antigravity/models` returns the pinned upstream Antigravity catalog with the API key group's model allowlist applied. It validates key and IP access without reserving an account or contacting a provider.

OpenAI API-key accounts support `POST /v1/images/edits` and `/images/edits` with JSON image URLs or multipart uploads, including multiple images and masks. Model mapping, streaming image events, and provider token usage use the same gateway pipeline as image generation. The default image model is `gpt-image-2`.
OpenAI OAuth subscription accounts support native Codex image generation and editing for `gpt-image-1.5`, `gpt-image-2`, and the `gpt-image-2.5-flare` and `gpt-image-2.5-sunburst` models, including their supported snapshots. Multipart images and masks are converted to data URLs inside the cloud gateway.

Grok API-key and OAuth accounts also support `POST /v1/images/generations` and `/v1/images/edits`. Grok requests require an explicit Imagine image model; `grok-imagine` resolves to `grok-imagine-image-quality`. Edits accept JSON `image`, `images`, or `reference_images` references (URL strings or image objects), or multipart uploads with up to three source images and an optional mask. The gateway converts `size` into native resolution and aspect ratio parameters.
Image responses support `b64_json` and MIME-aware data URLs with `response_format=url`. Streaming edits emit `image_edit.*` events; complete JSON responses from the upstream are adapted into SSE completion events with token usage recorded once.
Enable image generation in the group settings to allow synchronous images, asynchronous tasks, and Responses image tools. Closing the permission prevents queued tasks from starting while completed results remain readable.

Asynchronous image generation and editing use `POST /v1/images/generations/async`, `POST /v1/images/edits/async`, and `GET /v1/images/tasks/:task_id`, including root aliases. Submit returns HTTP 202 with `poll_url`; poll with the same API key to retrieve each task. Accepted requests and generated files are stored privately in Supabase, with signed result links valid for ten minutes. Tasks expire after 24 hours; a signed minute scheduler executes queued work and removes expired files. Interrupted inference is recovered from stored results without generating again. Each key can queue four tasks, with sixteen per user. Image inference uses the gateway's 120-second execution timeout. Run `npm run verify:images -- --edit` with `.local/agent-access.json` to verify generation, multipart editing, authenticated polling, and signed downloads against a configured account.

Other OAuth image models use the Responses `image_generation` bridge, including image inputs, masks, partial-image events, and completion usage. The bridge keeps image model selection separate from the Responses driver.


Grok groups support asynchronous video creation at `POST /v1/videos` and `/v1/videos/generations`, editing at `/v1/videos/edits`, and extension at `/v1/videos/extensions`. Specify a video model and prompt; edits and extensions take a `video.url` source, and extensions can omit the prompt. Poll `GET /v1/videos/{request_id}` with the creating gateway key. Download through `GET /v1/videos/{request_id}/content` with the same key; binary streaming, byte ranges, and cancellation are supported. Status responses return this authenticated gateway URL instead of provider signatures. Supabase binds each public task ID to its key, group, model, and subscription account. An uncertain creation includes the public task ID in its error response and returns `creation_unknown` when polled; the gateway does not automatically resubmit it.

Grok groups support `POST /v1/tts` and `/v1/stt` with API-key or OAuth authentication. The gateway preserves synthesis options, multipart upload boundaries, transcription JSON, and binary audio responses. Voice requests use the official xAI Voice API and release their account slots on completion or cancellation. Custom voice profiles use `POST /v1/custom-voices`, `GET /v1/custom-voices`, and `GET`, `PATCH`, or `DELETE /v1/custom-voices/{voice_id}`. Retrieve a sample with `GET /v1/custom-voices/{voice_id}/audio`. Uploads and query parameters pass through unchanged. Realtime voice uses `GET /v1/realtime?model=grok-voice-latest` with a WebSocket upgrade and the same Bearer key. Convert the API URL from `https://` to `wss://`. Text and binary frames pass through; account proxy settings apply to the upstream handshake. Connections currently share the gateway’s 120-second request lifetime.

Grok groups support `POST /v1/web_search` and `/v1/x_search`, plus their root aliases, with API-key and OAuth accounts. Requests accept `query` or `input` and up to 20 results; X search also accepts handle, date, image, and video filters. Returned summaries are matched to actual provider sources before results are exposed.

Codex standalone web search is available at `POST /v1/alpha/search`, `/alpha/search`, and `/backend-api/codex/alpha/search`. OpenAI OAuth and API-key accounts use their native endpoints; personal access tokens use the hosted Responses web-search fallback. Successful searches record one uncharged search call, while failed searches do not create successful usage records.


AI request bodies default to 256 MiB at both the cloud gateway and the local console proxy, matching upstream Sub2API. Text-specific routes (embeddings, search, and systemone) use 32 MiB. Configure `SERVER_MAX_REQUEST_BODY_SIZE`, `GATEWAY_MAX_BODY_SIZE`, and `GATEWAY_TEXT_MAX_BODY_SIZE` in bytes before deployment. Setting the server limit to `0` disables only the server-wide cap; gateway limits still apply. Supabase runtime memory and provider limits may reduce the practical maximum for large attachments.

Transient cloud request leases retain a 30-day replay window. Hourly maintenance removes up to 1,000 older expired leases per run while preserving usage history and leases referenced by cache creation or video tasks.

## License

Based on [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api). Licensed under LGPL-3.0-or-later. Upstream licenses and attribution are retained in [LICENSE](LICENSE), [COPYING](COPYING), and [NOTICE](NOTICE).
