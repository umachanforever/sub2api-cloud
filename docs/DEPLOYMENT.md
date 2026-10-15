# Supabase Deployment

This project provides a Supabase-hosted TypeScript gateway with the original Vue administration console. The AI gateway uses the dedicated Supabase project, while the business database and Mini Program authentication remain independent.

## Deployment profile

- Supabase Edge Functions host the `subscription-api` gateway and management API.
- Supabase PostgreSQL stores encrypted provider credentials, groups, keys, usage records, announcements, and audit records.
- Supabase Auth provides administrator and user authentication for the AI console.
- The Vue console runs locally or in the `sub2api-supabase-console` Docker container.
- Cloud deployment uses the HTTPS endpoint supplied by Supabase and does not require a separately managed server or domain.

## Release configuration

The cloud gateway runs directly in Supabase Edge Functions. The Go toolchain is required only when building the local management backend from source.

Configure `.env.local` from `.env.example`, apply the database migrations, deploy the Edge Function, and start the local console with `npm run up -- --cloud`. The local Supabase mode is available with `npm run up -- --local` for an entirely local deployment.

The release keeps service credentials and encryption keys on the server side. The console receives only the project URL and publishable key. Existing Supabase Auth users and administrator UUIDs remain under the project owner’s control.

## Registration and confirmation email

Configure public registration, invitation codes, email-domain rules, initial credit, concurrency, request limits, and default subscriptions in the administration console. Invitation codes are consumed atomically when Auth creates a user. Promotional codes provide additional credit, support expiration and total-use limits, and retain per-user usage records. Invalid or exhausted promotional codes leave registration and its default grants available, matching the upstream behavior. Administrator-created accounts use a private, single-use authorization and do not receive public registration grants.

Email-domain rules support exact domains and wildcard domains, including the wildcard root. With domain-limited registration enabled, domains outside a nonempty whitelist can register one account per registrable primary domain. The bundled Public Suffix List handles public suffixes, wildcard rules, and exceptions; the same database transaction enforces the quota under concurrent registration. An empty whitelist allows unrestricted domains.

Public registration checks canonical mailbox identities in the same transaction as account creation. Plus aliases, Gmail dot variants, Googlemail aliases, and domain root dots cannot obtain duplicate signup grants. Stored email addresses and existing users remain unchanged.

Email confirmation follows the project's Supabase Auth configuration. In cloud mode, configure the Site URL and allowed Redirect URLs in Supabase Authentication → URL Configuration. Set `SUPABASE_AUTH_SIGNUP_REDIRECT_URL` to the console's `/auth/callback` URL; its default is `http://127.0.0.1:3000/auth/callback`. Allow the console's `/reset-password` URL for password recovery too. Use the actual console port when overriding port 3000, and configure a production SMTP provider in Supabase for confirmation and recovery emails.

When confirmation is required, registration shows a confirmation notice and returns to sign-in. The email link opens the console callback, which validates the Supabase session before signing the user in. Passwords are never saved to browser session storage for this flow. Local mode uses the Auth URLs in `supabase/config.toml`; configuration changes take effect when the local Supabase stack is restarted.

## Management endpoint

Run the original Go management service locally and configure `MANAGEMENT_URL=http://127.0.0.1:8080`. The Docker console defaults to `http://host.docker.internal:8080`; use `http://management:8080` when both services share a Compose network. Management HTTP and WebSocket requests use this endpoint. Supabase Auth handles identity sessions and Edge Functions handle model requests. Configure custom navigation in the original administration settings.

## Account runtime recovery

The account console distinguishes authentication errors, rate limits, overload cooldowns, and temporary scheduling pauses. A rejected credential generation can mark an account as an error; results from an older generation cannot disable or cool down newly saved credentials. HTTP 403 responses use a temporary pause, HTTP 429 responses expose a rate-limit reset time, and server errors expose an overload cooldown. Billing and runtime updates commit together.

Use Clear Error to explicitly reactivate an account and clear its runtime blocks. Recover State restores an error account and removes runtime blocks while preserving a manually disabled account. Clear Rate Limit removes rate-limit and temporary runtime blocks without clearing an authentication error. Clearing a temporary pause preserves separate rate-limit and overload cooldowns. These operations retain manual scheduling controls, active requests, refresh ownership, credentials, and monetary balances. Batch error clearing reports each account's result independently.

## Dedicated user group rates

Administrators can assign a dedicated billing multiplier to a user for a specific group. Dedicated multipliers override the group default and apply to wallet charges and subscription quota usage. Multipliers must be positive, support six decimal places, and never grant group access. Each request captures its effective multiplier when scheduling begins; subsequent edits affect new requests.

The group's Rate Multipliers editor replaces that group's user multiplier list. User group settings update the specified groups; clearing a value restores the group default, and an empty rate map clears all dedicated multipliers for that user. Balance, group membership, concurrency, request limits, and dedicated rates are saved in one database transaction. Users can read their own multipliers through `GET /api/v1/groups/rates`.


## Group request limits

Each group can define a per-user request limit per minute. Administrators can override that limit for specific users through the group's RPM Overrides editor. A zero override disables the group limit for that user; the user's global RPM limit still applies across groups and keys. Clearing an override restores the group default.

Group counters are shared by all of a user's keys in that group. Successful scheduling consumes a request; provider retries reuse the original count. Billing multipliers and RPM overrides are managed independently, so replacing or clearing either configuration preserves the other.


## Public and exclusive groups

Public standard groups are available to every user by default. Exclusive standard groups require explicit user authorization. Enable Restrict Public Groups in a user's group editor to limit public access to the selected groups as well. Restriction changes apply to existing API keys on their next request, and disabled groups cannot receive new keys or requests.

Subscription groups require an active subscription within its start and expiration dates. Subscriptions grant access independently of the standard group authorization list. Existing groups retain their exclusive status during upgrades; newly created groups default to public unless marked exclusive. The user profile includes `restrict_public_groups`, and the available-group API returns all groups the current user can bind.


## API key spending windows

API keys can define independent spending caps for five hours, one day, and seven days. A zero cap is unlimited. Windows accumulate the request's actual charge after its billing multiplier, including subscription charges. Requests are rejected once any active window reaches its cap. Unknown or free charges do not consume spending limits. Completed requests retain their billing snapshots and settle once.

Five-hour windows start with the first paid request. Daily and seven-day windows start at UTC midnight on the first paid request and reset independently when expired. The console shows effective usage and reset times. Reset Rate Limit Usage clears the three counters and their start times without deleting historical usage, total quota usage, or wallet transactions.

Custom keys support letters, digits, underscores, and hyphens, with a minimum length of 16 characters. The full key is returned on creation; storage retains its SHA-256 digest and a four-character display prefix. Key digests remain unique across users. Invalid and duplicate custom-key attempts are limited to 20 failures per user per hour; generated keys use the regular creation flow.


## User platform quotas

Administrators can configure daily, weekly, and monthly spending limits for each user and provider. These limits aggregate actual wallet charges across every key and group on the same platform. Subscription charges are exempt. A `null` limit is unlimited; a zero limit blocks balance-based requests on that platform.

Daily windows follow midnight in Asia/Shanghai, weekly windows begin on Monday, and monthly windows roll for 30 days from their first charge or manual reset. Expired usage is shown as zero and resets when the next charge settles. Editing limits preserves current usage and window starts. Removing a platform or clearing all three limits removes its quota configuration; configuring it again begins with fresh counters. Single-window resets preserve other windows, wallet transactions, and usage history.

Use Settings → Default Platform Quotas to set limits for new public registrations. Each signup saves a copy of the current defaults; later default changes leave existing users unchanged. Users can view their own limits and reset times through `GET /api/v1/user/platform-quotas`. Administrators can view, replace, and reset quotas through `/api/v1/admin/users/:id/platform-quotas` and its `/reset` action. Quota changes retain user and platform references in the private audit stream.

`GET /api/v1/admin/users/:id/rpm-status` reports the current user-wide request count and limit, plus each group represented by the user's undeleted keys. Group entries identify whether their effective limit comes from the group or a user override. Expired minute counters are displayed as zero.


## User attributes and list filters

Administrators can define text, textarea, integer, email, URL, date, select, and multi-select fields from Users → Custom Attributes. Definitions support display order, enabled state, required values, options, placeholders, and validation rules. Disabled definitions cannot receive new values. Deleting a definition removes its saved values and releases its key for reuse.

Attribute values are strings and belong to Supabase user UUIDs. Numeric fields accept signed 64-bit integers; optional empty fields are retained as empty strings. Multi-select fields accept a JSON string array or comma-separated option values. Validation applies to each submitted field, and an invalid field rejects the entire value patch. Pattern rules use PostgreSQL regular expressions, including POSIX character classes. Email, URL, and date fields use the configured validation rules.

The administrator user list supports case-insensitive substring filters for authorized group names, custom attributes, and the group associated with an undeleted API key. Multiple attribute filters combine with AND. Attribute definition and value endpoints require administrator access; audit records track changed field names without retaining attribute values.


## Administrator roles

`SUB2API_ADMIN_USER_IDS` initializes administrator roles on the first authenticated management request. Initialization uses existing, active Supabase Auth users and runs once per database. Later changes to that environment variable do not restore revoked privileges. Manage administrator roles through the Users editor or create a user with the Administrator role.

Every management request resolves current roles from PostgreSQL. Revocation takes effect on the next request, including sessions created before the change. User metadata and Auth metadata cannot grant application administrator access. Disabled and deleted users have no active administrator privileges.

Administrators cannot demote, disable, or delete themselves. Database safeguards also protect the last active administrator from concurrent disable and delete operations, including operations through native Supabase Auth. Role changes are recorded in the private audit stream. Application administrator roles are independent of Supabase project membership and other applications' sign-in flows.


## Account cost and scheduling load

An account's Rate Multiplier controls account cost reporting. The user or group multiplier continues to control wallet charges, subscriptions, API-key spending, and platform quotas. A zero account multiplier reports zero account cost while retaining normal user charges. Each scheduled request snapshots its account multiplier, so editing the account during a request does not change that request's settlement. Historical usage without a snapshot uses an account multiplier of one.

Set Load Factor to compare the utilization of accounts sharing the same priority. The scheduler chooses the lowest active-request count divided by its load factor, followed by the least recently used account. An empty or nonpositive value clears the override and uses the account's concurrency setting. Load factors never increase the actual concurrency limit. Values above 10,000 are rejected.

The administrator dashboard and usage records expose account costs and multiplier snapshots. Regular user endpoints retain user billing data without account cost fields. `GET /api/v1/admin/accounts/:id/today-stats` and `POST /api/v1/admin/accounts/today-stats/batch` report requests, tokens, account cost, standard cost, and user cost since midnight in Asia/Shanghai. Unreported costs remain unknown in usage records, and statistics include a count of attempts with unknown costs. Batch requests accept up to 500 account UUIDs and return zero statistics for accounts without usage.


## Group privacy requirements

Enable Require Privacy Set on a group to restrict scheduling to accounts with the required saved privacy status. OpenAI accounts must have `extra.privacy_mode` set to `training_off`; missing or failed states are ineligible. Anthropic and Gemini accounts have no corresponding privacy flag and retain their normal scheduling eligibility.

The requirement applies to the requesting group. A shared account can remain eligible in another group without this requirement, and changing the requirement affects subsequent scheduling without altering account status or existing leases. Account lists support exact privacy-state filtering and `privacy_mode=__unset__` for missing or empty states. Group creation, editing, duplication, and available-group responses preserve the privacy requirement.


## Durable privacy verification

OpenAI OAuth accounts with missing or failed privacy settings enter a PostgreSQL retry queue atomically with account creation. Each worker claims up to four accounts with expiring leases. Credential changes fence stale workers, interrupted jobs are reclaimed, and failed checks use exponential backoff up to six hours. Cloudflare challenges wait at least fifteen minutes before retrying.

The deployment commands configure `pg_cron`, `pg_net`, `pgcrypto`, and Supabase Vault. A minute schedule invokes the Edge worker only when accounts are due. The service credential remains encrypted in Vault; outbound requests carry a scoped signature valid for ninety seconds. The console receives no scheduler secrets. Cloud scheduling continues when the local Supabase stack is stopped.

To disable the schedule, call the service-only RPC `s2a_privacy_scheduler_configure` with `p_url: null`, `p_service_key: null`, and `p_enabled: false`. This removes its own schedule and Vault secret while retaining account retry records. Running the deployment command configures it again.


## Account model synchronization

Use Sync Upstream Models in the account model selector to retrieve live IDs for OpenAI, Anthropic, or Gemini API-key accounts and OpenAI OAuth accounts. Creating an API-key account also supports a preview before saving credentials. Discovery uses the official provider origin and rejects redirects.

The gateway normalizes display labels, reasoning levels, input modalities, context limits, output limits, and supported Codex tool capabilities. Missing capabilities can be enriched from the public models.dev registry, cached for six hours. Concrete model mapping targets are included in enrichment even when the live list omits them. Image and video generators remain in the model list without affecting agent capability completeness.

Complete capability records are stored with a timestamp and source. Partial results retain existing records for models still listed or mapped. When a provider does not offer a model-list endpoint, configured mapping targets can be enriched while preserving earlier snapshots. Credential or mapping changes during discovery reject the stale save. Registry failures never replace a snapshot with an empty result. Capability snapshots are preserved by account editing and backup restoration.


## OpenAI quota cards

OpenAI OAuth account cards can query the live ChatGPT/Codex quota service. The response includes rate-limit windows, feature-specific limits, spendable credits, and available reset-credit expiration details. API-key accounts use their provider API billing rather than this subscription quota endpoint.

`GET /api/v1/admin/openai/accounts/:id/quota` reads the upstream quota. `POST /api/v1/admin/openai/accounts/:id/quota/refresh` also saves the console display caches. Both routes require an administrator session, use the fixed ChatGPT origin, reject redirects, and share the durable OAuth refresh path.

Spendable balances remain decimal strings to preserve precision. Missing credit balances are stored as unknown. Reset-credit snapshots are replaced only when their expiration information is complete; otherwise the earlier snapshot remains available and `cache_persisted` is false. Credential-version and timestamp checks prevent stale requests from overwriting newer caches. `credits_cache_persisted` reports the separate spendable-credit cache result. Account editing and backups preserve both display snapshots.

### Manual quota resets

`POST /api/v1/admin/openai/accounts/:id/reset-quota` consumes an available subscription reset credit. It requires an administrator session and an `Idempotency-Key` of 1–128 ASCII letters, digits, periods, underscores, colons, or hyphens. Reuse the same key after a timeout. The console retains its key across retries and page reloads; a new completed action receives a new key.

PostgreSQL records the redemption ID before dispatch. Concurrent actions for the same provider account share one pending operation. An interrupted operation can resume after its three-minute lease expires, retaining the same upstream redemption ID. Recorded consumption resumes account recovery and quota caching without consuming again; completed operations replay their stored result and load the current public account.

After consumption, the service recovers account runtime state and refreshes the quota, credit, and five-hour/seven-day display caches. A successful consumption remains successful if local recovery fails. The response includes `account_state_recovered`, `cache_refreshed`, and an optional `warning_code` identifying the failed recovery stage. Window snapshots survive account editing and backups. Browser cancellation does not cancel an already dispatched consumption request.

### Automatic quota resets

Enable Auto Reset Credit in an OpenAI OAuth account's editor to consume reset credits automatically. The feature is off by default. Five-hour and seven-day thresholds are independent ratios between `0.001` and `1`, shown as percentages in the console; both default to 100%. Either threshold can trigger consumption. Disabled accounts and accounts with scheduling disabled are excluded.

Supabase Cron checks due accounts each minute. Workers claim up to four accounts with three-minute leases. Accounts below their thresholds or confirmed to have no cards are checked again after ten minutes; query and recovery failures retry after one minute. Configuration changes and credential rotations invalidate stale workers. Disabling the switch cancels queued work and prevents dispatch by an existing worker. A request already dispatched retains its receipt even if the switch is subsequently disabled.

The worker requires complete official card IDs and expiration metadata, selects the earliest-expiring card, and sends both its ID and the durable redemption ID. An uncertain operation resumes the same card and redemption ID from the private journal. Workers never fall back to untargeted consumption or switch a pending attempt to another card. Console state contains hashes of attempt identities, status, timestamps, and safe error codes. Account edits and backup imports cannot replace managed worker state. Successful operations and failures retain private audit records.

Deployment configures the automatic schedule together with privacy verification. Both workers reuse the Vault service credential and receive separate short-lived signed tickets. To stop automatic scheduling independently, call the service-only RPC `s2a_openai_auto_reset_scheduler_configure` with `p_enabled: false`. Deployment enables the schedule again; account switches remain under administrator control.

### Quota-based account pauses

Configure an account's five-hour and seven-day automatic pause thresholds in its editor. Thresholds are ratios from zero to one; a positive account threshold overrides the global default. A zero or missing account threshold inherits the global value. The per-window Disable Auto Pause switches exempt the account from the corresponding ordinary pause rule.

Administrators can configure global defaults with `PUT /api/v1/admin/settings`:

```json
{
  "openai_account_quota_auto_pause": {
    "default_threshold_5h": 0.95,
    "default_threshold_7d": 0.9
  }
}
```

Zero disables the corresponding global default. These settings remain private to administrators. The database scheduler skips an account when a usable window snapshot reaches its effective threshold and selects another eligible account. It resumes selection when the absolute reset time passes, or when the relative reset time anchored to the snapshot passes. A snapshot older than two hours cannot keep an account paused without a known future reset time. A missing snapshot timestamp remains subject to its saved threshold.

With automatic reset credits enabled, reaching the reset threshold pauses selection until the reset workflow completes. A fresh worker state confirming available cards can defer an ordinary pause until the separate reset threshold. Disabling ordinary auto-pause does not disable the reset threshold.

OpenAI OAuth responses update window snapshots from the Codex rate-limit headers, including failed upstream responses. Partial headers retain known values; unknown percentages are never replaced with zero. Header persistence runs alongside the response and completes before usage settlement. Credential and timestamp checks reject stale updates, and header snapshots preserve spendable-credit caches. A newly reached threshold wakes the automatic reset queue without invalidating an active worker's lease.


## Runtime system logs

The operations console manages log severity, access-log persistence, sampling, caller information, and retention through `/api/v1/admin/ops/runtime/logging`. Access logs are off by default. System logs are retained for 30 days, and request usage history is retained indefinitely unless an administrator sets a positive request retention period. Resetting runtime logging restores these defaults.

Gateway settlement records include request, user, key, account, provider, model, status, outcome, and elapsed time. Edge response records report time to response headers as `response_started_ms`, including streaming responses. Messages use fixed event codes. Credentials, request bodies, query strings, upstream error bodies, and raw exception messages are excluded. Error stack information contains only recognized function names. Log failures do not roll back request settlement.

The database sink writes directly; its queue depth and capacity are zero. Health reports successful writes, sampled drops, database write failures, and average write delay. Transport failures are reported by the Edge runtime and cannot be counted in an unreachable database.

Logs support administrator-only pagination, time ranges, exact field filters, UUID identifiers, and literal message searches. Cleanup requires at least one explicit filter. Deployment enables `s2a-log-retention` in Supabase Cron, deleting expired logs and optional usage history in batches of 10,000 per minute. Usage expiry preserves wallet balances, ledger entries, key spending windows, and request settlement idempotency; historical usage views follow the configured retention period. The service-only RPC `s2a_log_scheduler_configure` accepts `p_enabled: false` to stop the schedule. Deployment enables it again.


## Operations metric thresholds

Administrators configure dashboard highlighting through `GET` and `PUT /api/v1/admin/ops/settings/metric-thresholds`. The defaults are a minimum SLA of 99.5%, a maximum first-token P99 latency of 500 ms, and maximum request and upstream error rates of 5%. Percentage thresholds accept values from 0 to 100; latency thresholds accept nonnegative milliseconds.

Each threshold can be disabled independently by setting it to `null`. Zero remains an active threshold. Updates replace all four values; omitted fields become disabled. Clearing a number field in the console saves `null`, and reopening the settings preserves it. Changes are private, persistent, and recorded in the administrator audit log. These thresholds control dashboard highlighting; notification rules use their own conditions.


## Request and upstream errors

The gateway stores client failures and provider attempts separately. A recovered provider failure remains in the upstream journal without creating a failed client request. Exhausted account attempts share one request ID with the final failure. OAuth authorization retries retain both observed provider responses. Incomplete streams remain failures even when their response headers reported HTTP 200; the stored status preserves that observation. Client stream cancellation is excluded from provider failures.

Administrators use `/api/v1/admin/ops/request-errors` and `/api/v1/admin/ops/upstream-errors` to list and inspect errors. Filters cover time ranges, UUID user/key/account/group identifiers, categories, status codes, resolution state, and message or metadata searches. Lists support bounded pagination and sorting by creation time, model, or status. The `errors` view excludes business limits, `excluded` selects them, and `all` includes both. Linked upstream attempts are available at `/api/v1/admin/ops/request-errors/:id/upstream-errors`. Legacy `/api/v1/admin/ops/errors` detail and resolution routes remain available.

Use `PUT .../:id/resolve` with `{"resolved": true}` to mark an error resolved, or `false` to reopen it. PostgreSQL checks the acting administrator's current role and records actual changes in the audit log. Repeating the same state is idempotent. Error records preserve user, key, account, model, and routed group attribution. Key names remain available after soft deletion.

Signed-in users access only their own client failures at `/api/v1/usage/errors` and `/api/v1/usage/errors/:id`. These views omit account identifiers, provider internals, key prefixes, and email addresses. Calendar date filters follow the selected timezone, including daylight-saving transitions; the default is the current seven-day period in Asia/Shanghai. End dates include their entire local day.

Error bodies contain stable gateway codes. Request prompts, authorization headers, encrypted credentials, upstream response bodies, and raw exception text are excluded. Unknown stream modes and unavailable timing details remain unknown. Error journals are independent of system-log severity and sampling, and their writes cannot fail the API or roll back usage settlement. The Supabase retention schedule removes errors older than 30 days in batches of 10,000.

## Request drill-down

Administrators inspect successful and failed client requests through `GET /api/v1/admin/ops/requests`. Failed provider retries remain in the upstream journal; they do not create successful request rows. The request list includes interrupted HTTP 200 streams as errors with their observed status and a link to the error detail.

Filters include time ranges, UUID user/key/account/group identifiers, provider, model, request ID, literal searches, and inclusive duration limits. Time windows include the start and exclude the end. Pagination accepts up to 100 rows, with stable creation-time, duration, or first-token sorting. Unknown timing values sort last. Responses include account names; the console uses the account-list fallback for older responses.

First-token latency measures elapsed time from the Edge request start to the first parsed generation event. Text, reasoning, tool arguments, and supported media output count as generation; heartbeats, role announcements, empty deltas, and usage-only events do not. Codex, OpenAI, Anthropic, and Gemini streams save this measurement with usage settlement, including streams interrupted after generation begins. Repeated settlement preserves the first saved value. Native non-streaming responses and streams without a generation event retain unknown latency. Settlement duration covers the account lease lifetime.

## Operations dashboard

The administrator dashboard provides an overview, a consistent snapshot, throughput and error trends, HTTP status distributions, and latency histograms through `/api/v1/admin/ops/dashboard`. A snapshot computes the overview and both trends from one PostgreSQL statement. Provider and UUID group filters apply to every section. Time windows include the start and exclude the end, and can cover up to 31 days.

SLA is the ratio of successful requests to successful requests plus failures outside business limits. Authentication limits, spending limits, rate limits, and client cancellations remain visible in total request counts while their excluded classification keeps them outside the SLA denominator. Stream failures count as errors even when the observed HTTP status is 200. Provider attempts are counted independently; recovered attempts remain visible, and 429 and 529 have separate counters. Switching between accounts counts a switch, while OAuth recovery on the same account does not.

Token consumption sums known input and output values from all generation attempts, including interrupted output. Normalized input already includes cached input, so cache tokens are counted once. Model discovery is excluded from generation usage and successful request statistics. The console identifies partial totals when an attempt has incomplete usage. Latency percentiles use individual successful request samples and preserve zero measurements; unavailable measurements remain null. Output TPS summarizes successful token generation samples independently of aggregate traffic TPS.

Trend buckets fill intervals without activity. Partial edge buckets use their actual overlap with the selected window. Overview current rates cover the final minute of the window, peak rates use one-minute buckets, and average rates cover the complete window. Histograms preserve the original boundaries at 100, 200, 500, 1000, and 2000 milliseconds.

The model performance card uses `/api/v1/admin/ops/dashboard/openai-token-stats` for every supported provider. Available ranges are 30 minutes, one hour, one day, 15 days, and 30 days. Select a provider and UUID group, then use either Top N or pagination. Both modes support up to 100 models per response and report the complete number of matching models. Top N cannot be combined with pagination parameters.

Model statistics group completed generation requests by the requested model name, including aliases. Output TPS is the average of individual request rates with known positive output and duration. First-token averages include measured zero values and exclude unknown values. Missing output totals remain null when no output is known; mixed totals retain their known values and report the number of requests without output usage. Failed retries, interrupted streams, and model discovery do not become successful model samples.

## Operations alert rules and events

Administrators manage rules at `/api/v1/admin/ops/alert-rules` and inspect events at `/api/v1/admin/ops/alert-events`. Rules define a metric, comparison, threshold, severity (`P0` through `P3`), a 1-, 5-, or 60-minute window, a sustained duration, and a cooldown. Provider and UUID group scopes follow the dashboard filters. Percentage thresholds range from 0 to 100; count thresholds are nonnegative.

Supabase evaluates traffic rates and account availability with durable breach counters. A rule creates at most one firing event. A healthy measurement resolves it automatically; an unavailable measurement resets the breach counter and preserves the event's current status. Manual resolution uses `PUT /api/v1/admin/ops/alert-events/:id/status`. Cooldown starts at the previous event's firing time. Editing a rule resets its breach counter, and deleting a rule removes its events, silences, and evaluation state.

Event lists use descending firing time and ID. Pass both `before_fired_at` and `before_id` for stable cursor pagination. Filters include severity, status, delivery status, time range, provider, and UUID group. Scoped silences at `/api/v1/admin/ops/alert-silences` match the rule, provider, group, and region exactly and prevent new firing events until their expiry.

Runtime settings at `/api/v1/admin/ops/runtime/alert` configure the evaluation interval and PostgreSQL leadership lock. The configured lock lifetime bounds each evaluation transaction; exceeding it rolls back the run. Deployment installs `s2a-ops-alert-evaluation` in Supabase Cron. Intervals below one minute use second-based schedules; longer intervals use minute ticks with a persisted interval guard. Metric highlighting remains controlled by its dedicated settings endpoint, so saving runtime settings cannot overwrite it.

## Operations email delivery

Configure the SMTP host, port, username, password, and sender in the console’s general settings. Passwords are encrypted in private PostgreSQL storage and never returned by settings APIs. An empty password retains the saved password; changing the host, port, or username requires a new password. The original connection-test and test-email actions use these settings. SMTP takes priority over Resend; clear the SMTP host to disable it. Alternatively, configure `RESEND_API_KEY` and a verified sender address in `SUB2API_MAIL_FROM`, then deploy the backend. These values are private Edge secrets. Without a configured transport, the delivery worker leaves queued messages untouched. The console's operations settings manage recipients, minimum severity, hourly limits, batch windows, resolved notifications, and scheduled reports through `/api/v1/admin/ops/email-notification/config`.

The SMTP TLS switch supports implicit TLS and mandatory STARTTLS on custom ports, with certificate verification. Remote password authentication always requires TLS. The selected Supabase environment must permit outbound connections to the configured port. Supabase Auth confirmation and recovery email use the separate Auth SMTP configuration.

Alerts enter a private PostgreSQL queue. Runtime global, rule, and severity silences apply to email independently of event creation. Minimum email severity maps `P0` to critical, `P1` to warning, and `P2`/`P3` to info. A batch window combines notifications for the same recipient. Hourly limits reserve alert delivery attempts transactionally, including retries, so concurrent workers cannot exceed the configured limit. Reports use their own enabled flags and recipient list.

`Supabase Cron` runs `s2a-ops-mail-delivery` every minute. Dispatch uses a short-lived signature; the service credential stays in Vault and is excluded from the HTTP queue. Workers claim up to four deliveries with two-minute leases. Provider acceptance sets the delivery's sent state and the corresponding alert events' `email_sent` flag. Failed attempts use exponential backoff with up to eight attempts. Retries reuse the delivery ID and unchanged payload. Resend retries expire after 23 hours, before its 24-hour idempotency window ends. SMTP deliveries stop after an uncertain submission or an expired sending lease because the server may already have accepted the message. Changing transports stops outstanding deliveries previously bound to the other transport.

Daily and weekly reports summarize the preceding 24 hours and seven days. Error digests apply the configured minimum record count and include a category/status breakdown. Account health reports include current availability and accounts whose observed request error rate meets the configured threshold. Each scheduled report runs at most once per minute. Cron schedules use the Supabase Cron timezone, normally UTC; configure their hours accordingly. Disabling a report removes its schedule and prevents queued deliveries for that report from being claimed.

## Realtime operations WebSocket

The original `/api/v1/admin/ops/ws/qps` endpoint streams `qps_update` messages every two seconds with observed one-minute QPS, TPS, request counts, and unknown-token counts. The console authenticates through the `sub2api-admin` and `jwt.<session>` subprotocols; the server negotiates only `sub2api-admin`. Session tokens are never placed in URLs. The local proxy and Vite forward WebSocket upgrades to Supabase.

Private PostgreSQL leases enforce 100 simultaneous connections per deployment and 20 per administrator across Edge workers. Expired leases release capacity after 30 seconds. Each update validates the Auth session and current administrator role. Disabling monitoring closes connections with code `4001`; slow consumers and revoked sessions also close. Connections rotate after 90 seconds to stay within Edge runtime limits, and the console reconnects automatically.

## Proxy registry

Administrators manage HTTP, HTTPS, SOCKS5, and SOCKS5h proxies in the original console. The registry supports paginated filters, active selectors, password-preserving edits, expiration dates, batch creation with connection deduplication, and batch deletion with per-record outcomes. Account or backup references prevent deletion. Backup chains are validated transactionally to reject cycles.

Proxy passwords are encrypted in private PostgreSQL storage. The administrator API retains the original console’s password display and authenticated connection-URL copying; ordinary users cannot read the registry. An omitted password retains the saved value, and an explicit empty password clears it. Concurrent edits return a conflict rather than overwriting changes.

The connection test uses the selected proxy through Supabase’s native HTTP client and stores measured latency and exit-IP metadata. Changing the connection configuration invalidates previous probe results. Results from probes started before an edit cannot overwrite the new configuration. Provider failures use fixed messages that exclude proxy credentials and response bodies. Operations alert rules evaluate expired and expiring-soon counts from the registry; expiring-soon rules use each active proxy’s warning interval.

Account creation, editing, and OAuth authorization accept a selected proxy. Provider traffic, token refresh, model discovery, privacy changes, and OpenAI quota operations use that binding. Database and authentication requests use their configured Supabase connection. Account responses expose proxy metadata without its credentials.

Supabase Cron checks expired proxies every minute. A configured backup chain selects the next active, unexpired proxy, or switches to a direct connection. Without a usable fallback, the original connection remains selected. Repeated fallback preserves the first proxy as the recovery origin. Administrators can restore that origin from the account console or clear recovery state by selecting a proxy explicitly.
