# sub2api-cloud

[English](README.md) | [简体中文](README.zh-CN.md)

An AI API gateway for subscription accounts and provider API keys, powered by Supabase. Manage accounts, API keys, and usage through a local web console.

- Connect OpenAI, Anthropic, Gemini, and other supported providers.
- Responses, Chat Completions, Messages, and Gemini API formats, with streaming and attachment support depending on the provider.
- Multiple subscription accounts, model discovery, and model aliases.
- Per-account usage and subscription allowances, where provided by the upstream service.
- Cloud authentication, automatic credential refresh, and usage recording.
- Local or cloud Supabase deployment. Cloud API access continues when the local console is stopped.

Supabase provides free-tier hosting and an HTTPS endpoint, reducing server and domain costs. Clients worldwide can access OpenAI, Anthropic, Gemini, and other supported APIs through the cloud gateway. Clients in mainland China can also connect without a VPN or local proxy. Usage quotas depend on your upstream account and [Supabase plan](https://supabase.com/pricing).

## Quick start

Install Node.js 24+, Docker Compose 2.24+, and the Supabase CLI. Create a Supabase project, then:

```sh
cp .env.example .env.local
chmod 600 .env.local
```

Fill in `.env.local`:

| Setting | Value |
| --- | --- |
| `SUPABASE_URL` | Project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable or anon key |
| `SUPABASE_DB_PASSWORD` | Database password |
| `SUPABASE_ACCESS_TOKEN` | Supabase access token |
| `SUB2API_LOCAL_ADMIN_EMAIL` | Administrator email |

Leave `SUPABASE_SERVICE_ROLE_KEY` blank to retrieve it automatically during setup.

```sh
npm run up -- --cloud
```

Open [the console](http://127.0.0.1:3000), sign in, add a provider account, assign it to a matching group, and create an API key. Generated administrator credentials are saved in `.env.local`.

For local Supabase, use `npm run up -- --local`. Stop the local Supabase stack with `npm run down -- --local` when switching to cloud mode.

## API

Use the base URL shown in the console:

```text
https://<project-ref>.supabase.co/functions/v1/sub2api/v1
```

```sh
export OPENAI_BASE_URL='https://<project-ref>.supabase.co/functions/v1/sub2api/v1'
export OPENAI_API_KEY='sk-your-key'

curl "$OPENAI_BASE_URL/models" \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

Use the same key with `/responses`, `/chat/completions`, and `/usage`. The usage endpoint lists enabled accounts separately, with provider-specific quota windows in `windows`. Accounts without an upstream quota API are marked `supported: false`. Add `?refresh=true` for a fresh upstream reading.

Open usage directly in a browser: `https://<project-ref>.supabase.co/functions/v1/sub2api/usage?key=<your-api-key>`. It shows only accounts authorized by that key.

Model aliases such as `gpt-6` and `gpt-6.1` select their `-sol` variants unless an account mapping overrides them. Available models depend on your subscription account.

Gemini and Antigravity model lists show only models that complete an actual inference probe with usable output. A listing verifies models for up to 50 seconds; pending models rotate on subsequent listings, and successful results are cached for 10 minutes per worker and client key. Temporary quota/capacity failures are retried later. The `x-s2a-model-verification` response header distinguishes verified, temporary, unsupported, and unverified counts. The first listing may take longer and consume provider quota. Antigravity supports thinking variants, account-tier endpoint selection, bounded retries, persistent model backoff with the upstream Gemini text quota scope and separate capacity handling, signature recovery, and explicitly opted-in AI Credits fallback; discovery probes never enable credit overages. See the [upstream parity audit](docs/UPSTREAM_MODEL_PARITY_AUDIT.md) for behavior and limits.

For native Gemini chat requests targeting `gemini-3-flash` or `gemini-3-flash-preview`, the gateway replaces unsupported IMAGE output modalities with TEXT and removes image-output configuration. User messages remain unchanged and the model supplies its own answer. Image models retain their generation options; provider errors remain errors. Native Gemini requests also restore gateway-generated Base64 image Markdown in model history to original inline image parts, preventing image bytes from exhausting the text context window.

For Responses clients that did not declare a web-search tool, automatic gateway search returns answer text and citations without exposing its internal tool events. Explicitly declared search tools retain their native events.

Chat supports native image generation. WorkBuddy displays original-image cards inline; click to preview, save or copy, without automatically opening the side panel. This requires client file tools and permission. Other clients retain inline images.

## Documentation

[Deployment](docs/DEPLOYMENT.md) · [Architecture](docs/ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md)

## License

Based on [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api), licensed under LGPL-3.0-or-later. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
