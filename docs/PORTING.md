# Compatibility and Architecture Notes

sub2api-supabase is an independent TypeScript implementation based on [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api), pinned to commit `9c2cca9e627291bc719bada3d57de23b625a4180`. It is licensed under LGPL-3.0-or-later; see [NOTICE](../NOTICE) for attribution.

The original Vue console is retained in `frontend/`, and the pinned Go backend is retained in `backend/` for local administration. See [Architecture](ARCHITECTURE.md) for the deployment boundary and shared data contract. A local Node proxy translates the browser-facing Supabase configuration, while the Edge Function provides the management and model gateway APIs. Administrator privileges are resolved from PostgreSQL on every management request. Deployment UUIDs initialize administrator roles once.

The gateway uses PostgreSQL reservations for account scheduling, per-key rate limits, encrypted credentials, and usage records. Refresh locks and credential versions provide safe OAuth rotation across concurrent instances. Requests and streaming output use the configured Supabase runtime timeout.

The service accepts official OpenAI, Anthropic, and Gemini protocols and provides Responses, Chat Completions, Anthropic Messages, and Gemini model routes. The console and API preserve provider-specific authentication, model catalogs, usage metadata, and audit records.

Sensitive credentials remain server-side. Browser clients receive only public configuration, and all management routes require Supabase Auth authorization.
