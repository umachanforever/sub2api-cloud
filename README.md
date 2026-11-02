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

Every entry in native Gemini and Antigravity model lists is verified with a small generation request using the client key’s normal routing and billing, including Claude names and custom aliases. Standard model lists also verify entries identified as Gemini/Antigravity models. Only successful models are returned; wildcard entries are omitted. Verification failures do not put the account into cooldown, so a quota-limited model cannot hide other working models. Verification runs at most two requests at a time, with a 10-second timeout per model and a 45-second budget per listing. Models not verified within that budget are omitted. Successful checks are cached for 10 minutes, unsupported models for 5 minutes, and transient failures for 15 seconds. The cache is scoped to the client key and lives in each gateway process, so cold starts repeat checks. The first listing may take longer and consumes a small amount of provider quota. Other providers retain their existing listing behavior.

Chat images use native image generation. WorkBuddy and other OpenAI OAuth clients declaring `show_widget` display original PNG/JPEG/WebP files through private Storage image sources signed for seven days, avoiding large base64 text deltas. The client renders an image rather than a bare link; SVG/HTML widget drawings do not replace generated art. Other clients and Antigravity retain inline image output with segmented streaming content. Image permissions, independent image tasks, and previous image references remain supported. Generated images stay inline by default, including when `present_files` is advertised; the gateway does not synthesize preview calls. Original source references remain available in model context for explicit download/copy/export requests, subject to client file tools and permissions.

## Documentation

[Deployment](docs/DEPLOYMENT.md) · [Architecture](docs/ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md)

## License

Based on [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api), licensed under LGPL-3.0-or-later. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
