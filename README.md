# sub2api-cloud

[English](README.md) | [简体中文](README.zh-CN.md)

An AI API gateway for subscription accounts and provider API keys, powered by Supabase. Manage accounts, API keys, and usage through a local web console.

- Connect OpenAI, Anthropic, Gemini, and other supported providers.
- Responses, Chat Completions, Messages, and Gemini API formats, with streaming and attachment support depending on the provider.
- Multiple subscription accounts, model discovery, and model aliases.
- Five-hour and seven-day usage windows for enabled OpenAI subscription accounts.
- Cloud authentication, automatic credential refresh, and usage recording.
- Local or cloud Supabase deployment. Cloud API access continues when the local console is stopped.

Supabase provides free-tier hosting and an HTTPS endpoint, reducing server and domain costs. Clients in mainland China can connect without a VPN where the Supabase endpoint is reachable. Availability and quotas depend on your network, upstream account, and [Supabase plan](https://supabase.com/pricing).

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

Use the same key with `/responses`, `/chat/completions`, and `/usage`. The usage endpoint lists enabled OpenAI subscription accounts separately; add `?refresh=true` for a fresh upstream reading.

Model aliases such as `gpt-6` and `gpt-6.1` select their `-sol` variants unless an account mapping overrides them. Available models depend on your subscription account.

## Documentation

[Deployment](docs/DEPLOYMENT.md) · [Architecture](docs/ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md)

## License

Based on [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api), licensed under LGPL-3.0-or-later. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
