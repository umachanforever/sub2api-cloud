# Product Scope

This project integrates a TypeScript AI gateway on Supabase with the original Sub2API Vue console and Go management backend. The deployment boundary and shared data contract are defined in [Architecture](ARCHITECTURE.md).

Upstream reference: [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api), pinned to commit `9c2cca9e627291bc719bada3d57de23b625a4180`.

## Platform architecture

| Component | Responsibility |
| --- | --- |
| Supabase Edge Functions | AI API authentication, provider gateway, OAuth refresh, streaming responses, and usage recording |
| Supabase PostgreSQL | Encrypted credentials, groups, access keys, scheduling leases, rate limits, usage records, announcements, and audit data |
| Supabase Auth | AI console sign-in, administrator access, password management, and TOTP protection |
| Local Go backend | Original management APIs and administrative workflows |
| Vue console | Account, group, key, usage, announcement, and administration views |
| Local Docker | Static console hosting and the local API proxy |

## Supported provider workflows

- OpenAI OAuth with PKCE authorization, encrypted credentials, refresh locking, reauthorization, and 401 retry.
- OpenAI upstream quota queries and explicit refreshes with rate-limit windows, exact Codex credit balances, reset-credit expirations, credential-fenced display caches, and unknown-value preservation.
- Manual OpenAI quota resets with durable redemption IDs, concurrent request coalescing, resumable receipts, and account recovery followed by quota window refresh.
- Optional account-level automatic quota resets with independent window thresholds, earliest-expiring card selection, private persistent attempt identities, credential and configuration fences, and Supabase scheduling.
- OpenAI quota-aware account selection with global and per-account pause thresholds, independent window exemptions, automatic window-rollover recovery, stale-snapshot guards, and live response-header snapshots.
- OpenAI training privacy settings on authorization, credential import, and refresh, with administrator retries, durable Supabase job scheduling, and privacy-aware group scheduling.
- Official OpenAI, Anthropic, and Gemini API-key protocols.
- Responses API, Chat Completions, Anthropic Messages, and Gemini model endpoints.
- Streaming and non-streaming responses with token usage records.
- Account pools with priority scheduling, concurrency reservations, rate limits, cooldowns, and failover.
- Account model mappings with exact and trailing wildcard admission, upstream model rewriting, mapped billing, immutable reservation snapshots, and alias-aware provider catalogs.
- Live account model synchronization and creation previews, models.dev capability enrichment, credential and mapping conflict checks, and durable capability snapshots preserved by account edits and backups.
- Administrator account model pickers with provider display metadata, account mapping reloads, OpenAI discovery and OAuth refresh, and configured fallback catalogs.

## Administration and identity

- Supabase Auth sessions with database-managed administrator roles.
- Group membership and account authorization, including unbound accounts, optional provider default groups, and binding changes that preserve in-flight requests and usage history.
- Ordered model allowlists with trailing wildcard rules, provider model candidates, request admission, and filtered OpenAI, Anthropic, Gemini, and Codex model catalogs.
- Complete group selectors and atomic inactive group copies that preserve account bindings, with administrator-scoped retry protection.
- API key issuance, rotation, expiration, revocation, and isolation.
- Administrator account backups with selected or filtered exports, recoverable credentials, model mappings, and scheduling metadata.
- Atomic backup restoration with per-record results, encrypted storage, optional default group binding, owner-scoped retry protection, and OpenAI ID-token metadata enrichment.
- User and administrator usage views, announcements with balance and subscription targeting, and audit records.
- Configurable public registration, invitations, signup credits and subscriptions, and multi-use promotional credits with usage history.
- Native TOTP enrollment, sign-in, unlinking, and elevated administrative verification.
- Independent request and upstream error journals with OAuth recovery and account-switch correlation, stream interruption handling, original administrator query/detail/resolution APIs, private personal error views, calendar date filters, and retention scheduling.
- Administrator request drill-down combining completed requests and final client errors, with UUID filters, duration ranges, stable pagination, account names, and independent duration and first-token sorting.
- First-token latency measurement for Codex, OpenAI, Anthropic, and Gemini streams, with atomic usage settlement, retry-safe timing, and personal and administrator usage views.
- Operations overview and consistent dashboard snapshots with SLA counts, throughput and error trends, provider and group breakdowns, recovered account switches, status distributions, latency histograms, and exact request-level percentiles.
- Live account, group, platform, and user concurrency with shared-pool capacity, lease expiry, privacy-aware availability, quota pauses, cooldowns, and unlimited user limits.
- Real-time QPS and TPS summaries with one-minute current rates, minute peaks, window averages, provider and group filters, and missing-usage indicators.
- Persisted monitoring switches with immediate management API gating, independent real-time card control, and error-journal suspension while billing history remains available.
- Operations advanced settings control cleanup schedules, independent error and metric retention, aggregation jobs, request-error inclusion, console cards, refresh intervals, and shared OpenAI quota thresholds.
- Scheduled minute and hourly operational aggregates with bounded historical backfill, idempotent refresh, request and upstream-error accounting, missing-token counts, recovered switches, and private storage.
- Hybrid operations overviews combine covered hourly aggregates with raw boundary fragments, retain archived totals after detail cleanup, and preserve unknown timing and peak values when individual samples are unavailable.
- Model performance statistics across supported providers with Top N and pagination modes, per-request output TPS, measured first-token averages, UUID group isolation, and explicit missing-output metadata.
- Persistent operations metric thresholds for SLA, first-token latency, request errors, and upstream errors, with independent disabled states and administrator audit records.
- Runtime system logging with configurable severity, optional access logs, database-wide sampling, UUID filters, scoped cleanup, sink statistics, and Supabase retention scheduling.
- Durable alert rules, scoped silences, sustained breach evaluation, recovery, cooldowns, and runtime configuration.
- Encrypted SMTP settings with connection and test-email actions, SMTP and Resend operations delivery, scheduled reports, leased queues, and duplicate-aware retry handling.
- Private encrypted proxy registry with the original administrator console, HTTP and SOCKS protocols, filters, batch operations, expiration metadata, transactional backup graph checks, and measured connectivity probes.
- Authenticated QPS/TPS WebSocket streams through Supabase and the local console, deployment-wide connection leases, role and session revalidation, monitoring controls, and automatic reconnects.

## Deployment modes

Cloud mode deploys the Edge Function and database migrations to a Supabase project and runs the console locally or through Docker. Local mode runs the Supabase stack and console on the developer workstation. Both modes use the same TypeScript gateway and configuration model.
