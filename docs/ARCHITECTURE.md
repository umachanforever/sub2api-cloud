# Architecture

## Deployment boundary

Reuse the upstream Go administration backend and Vue console. Keep cloud AI request handling independent of the workstation.

| Component | Responsibility | Location |
| --- | --- | --- |
| Vue console | Original administration screens and workflows | Local Docker |
| Go backend | Original management APIs and administrative services | Local Docker |
| Redis | Local management caches and sessions where required by Go | Local Docker |
| Supabase Edge Functions | AI API key validation, provider requests, streaming, account failover, and usage recording | Supabase |
| Supabase PostgreSQL | Authoritative accounts, groups, keys, credentials, and usage | Supabase |
| Supabase Auth | Cloud identity and authenticated access | Supabase |

In cloud mode, stopping local management containers must leave AI requests operational. The gateway must not call a workstation API or depend on local Redis for authentication, credential refresh, account selection or usage recording. Mini Program sign-in remains independent.

The primary deployment serves personal AI requests. Commercial charging, subscription settlement, and exact monetary pricing are outside the core cloud path. The original management screens remain available where backed by the shared data contract; cloud usage records retain provider-reported token counts without requiring a pricing engine.

## Shared data contract

Use the upstream business schema as the target management contract. Adapt the cloud gateway to that contract rather than reproducing administration features in TypeScript. Supabase identity mapping and gateway-specific transactional helpers may extend the schema.

The upstream schema uses integer business identifiers and provider credentials in JSON; the existing Edge implementation uses UUID identifiers, encrypted credentials, and `s2a_*` tables. Treat these as an explicit gateway integration boundary. A shared PostgreSQL host alone does not make the two implementations compatible.

Accounts, keys, balances, subscriptions, and usage must have one authoritative representation. Do not introduce periodically synchronized copies of balances or independently mutable account pools. Cloud request settlement and local management edits must observe the same records and transaction rules. Provider credentials remain private and encrypted at rest.

Go management authentication must validate the configured cloud identity and resolve current roles and account status. Service-role credentials and database credentials remain in the backend, never in the Vue bundle.

## Runtime ownership

Assign each credential refresh, quota reset, settlement, and notification task one owner. Disable conflicting upstream background workers before connecting the Go process to shared production records. Explicit administrator actions remain available through the original management services.

Supabase identity mode disables native Go model routes and native sign-in routes. Business profiles and public console settings remain available. Native password, MFA, passkey, and identity-binding handlers cannot mutate cloud identities.

Go does not start periodic token refresh, account/proxy/subscription expiry, automatic quota resets, provider balance probes, scheduler snapshots, deferred gateway writes, platform quota flushing, Gemini cache recovery, or batch-image execution and cleanup in this mode. Local management auditing, backups, and administrative monitoring remain local services.

Gateway key identity lookup reads the native `api_keys`, `users`, and `groups` records through `s2a_gateway_key_lookup`. New Go-issued keys acquire a SHA-256 digest in the same database transaction. Key revocation, group status, and group access changes take effect without cache propagation. The lookup does not replace transactional request admission or settlement.

`deploy/gateway-admission.sql` installs service-only native key admission and release RPCs. Admission locks the canonical user and key, enforces IP and model policies, checks key monetary windows, maintains subscription and platform quota windows, and reserves a bounded user concurrency lease. User global RPM ceilings apply alongside group limits and per-user group overrides. Subscription mode is exempt from standard platform quotas. Request IDs bind immutable policy snapshots and replay without consuming a second slot. Leases contain no provider credentials; provider selection and usage settlement use separate operations.

`deploy/gateway-pricing.sql` reads active native channels into private request pricing snapshots. Install it before `gateway-admission.sql`. Admission freezes the group, channel model mapping, billing model source, ordered model prices and intervals, account-statistics rules, and pricing timestamp. Account reservation returns the admitted policy for cloud pricing. Later management edits cannot change a replayed request's price configuration. Database identifiers in channel metadata remain decimal strings; provider credentials are excluded.

`deploy/gateway-billing.sql` installs the private user-charge operation for the cloud finish transaction. It uses the admitted subscription and multiplier snapshot, quantizes monetary amounts once to eight decimal places, and atomically updates native balances, subscription usage, key quotas, key monetary windows, and applicable platform quotas. Incurred usage remains payable after lease expiry or key revocation. Native hot and archived billing deduplication records prevent replay; conflicting usage fails the transaction. The helper has no public RPC grant; its caller must execute as the management owner.

## Personal gateway adapter

`deploy/personal-gateway.sql` installs the cloud request adapter after the native business migrations and `account-vault.sql`. It validates native keys and group access, preserves IP and model restrictions, selects an active account with a bounded request lease, and returns its Vault credential snapshot. Completion writes provider-reported token counts to the original `usage_logs` table with zero monetary costs and preserves nullable raw values in `s2a_personal_details`. Completion replay is idempotent and conflicting usage is rejected. It does not debit balances or require model price data.

The Edge runtime selects this contract with `SUB2API_DATA_MODEL=native`; an unset value retains the existing cloud data contract until cutover. Configure the native database before selecting it. Both paths use the existing provider transports, OAuth refresh fencing, model mapping, JSON handling, and SSE handling.

Run the isolated Go/API/database/HTTP acceptance with `S2A_ACCOUNT_VAULT=1 S2A_PERSONAL_HTTP=1`, the Supabase PostgreSQL image, and an installed Deno runtime. The HTTP fixture creates accounts and keys through the original Go API, uses synthetic provider responses, and reads the resulting usage through the original Go API. Live provider verification is a separate deployment gate.

## Provider credential storage

Apply `deploy/account-vault.sql` as the database administrator after native migrations and before importing accounts. Canonical account rows reside in the private schema and store Vault references. The native `accounts` view preserves the original Go JSON credential contract for authorized management queries. Public API roles cannot read the view, private table, or credential helper.

Credential RPCs and triggers execute as `s2a_management`, with explicit Vault read, create, decrypt, and delete permissions. They never execute as the database administrator and cannot read Supabase Auth tables. Writes encrypt credential documents through Supabase Vault in the same transaction as the account change. Metadata edits retain the current secret; credential changes replace it and remove the previous secret. Concurrent writes lock the canonical row and reject stale snapshots with a serialization error, preventing an older refresh from overwriting newer credentials. Backups must include the account rows and their encrypted Vault secret records together.

The Edge provider pipeline accepts Vault credential snapshots directly and validates them through the same provider credential readers. These documents remain in request memory and are never copied into a second account table. The gateway uses service-only credential snapshot and refresh RPCs. Refresh ownership is bounded by a database lease and credential version. Management reauthorization advances that version and revokes the previous refresh lease. The original Go console keeps its credential-presence indicators and never returns provider tokens in account responses.

Install `deploy/gateway-proxy.sql` after native migrations. Vault accounts resolve proxy connections through the native `proxies` table using a service-only RPC owned by the management role. Provider requests, OAuth refresh, and privacy updates share this route. Expired proxies follow the original backup or direct policy; missing or cyclic fallback chains retain the original connection. Proxy IDs remain decimal strings across the cloud boundary to preserve bigint precision.

## Deployment transition

Build the shared business schema as a fresh installation. Preserve the existing Supabase identity, both existing API keys including the key used by the application, and the provider credentials required to serve those keys. Create fresh business records for the rebuilt installation; historical balances, usage, and management records do not require migration. Verify the retained keys before switching application traffic. Mini Program sign-in is independent of this installation.

## Integration order

1. Retain and compile the pinned upstream backend.
2. Establish the shared schema, identity mapping, credential access, and transactional gateway integration.
3. Route console management calls to Go and AI requests directly to Edge.
4. Verify account edits, key revocation, balances, usage, and administrative permissions against the same records.
5. Verify cloud requests and usage recording while the local management stack is stopped.

Keep the current deployment available until the shared contract is verified. Do not point an unadapted upstream server at the active database or run its automatic migrations as part of source import.

## Database ownership

Apply `deploy/management-role.sql` as the database administrator, then supply a private login password for `s2a_management` through the deployment secret channel. Configure Go with `DATABASE_USER=s2a_management`. This role owns upstream business objects and has no elevated or inherited role privileges. Only database administrators may be members of this role, including Supabase's automatic administrator grants. Its default privileges exclude public API roles, including function execution. Bootstrap changes only this role's defaults; existing Supabase application defaults remain intact.

Cloud-enabled Go migration paths reject privileged database connections before creating tables. Both automatic setup and normal initialization enforce this boundary. The gateway receives access through explicitly authorized transactional helpers as the shared contract is connected.

Run `management -migrate` with private `DATABASE_URL` and `SUPABASE_URL` environment values to apply the embedded business migrations without starting HTTP listeners, Redis clients, mail queues, or background workers. Remote database connections require TLS. The command uses the same role guard, migration checksums, and advisory lock as normal initialization.

`scripts/accept-management.mjs` starts disposable PostgreSQL and Redis containers and verifies upstream migrations, object privileges, identity mapping, and management operations. It uses local Supabase Auth and synthetic business records. Supply `S2A_AUTH_ACCEPTANCE_EMAIL` and `S2A_AUTH_ACCEPTANCE_PASSWORD`, or use the private local administrator configuration. `S2A_MANAGEMENT_BINARY` selects the compiled Go server and `SUPABASE_BIN` selects the Supabase CLI.

Set `S2A_ACCOUNT_VAULT=1` and `S2A_POSTGRES_IMAGE=public.ecr.aws/supabase/postgres:17.11.0.003` to include Vault-backed native account creation, editing, refresh ownership, reauthorization fences, and concurrent credential replacement. This uses a disposable Supabase database image; the configured Auth project is used only for session verification.

## Go identity configuration

`SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` enable cloud identity validation in Go management middleware. `SUPABASE_JWT_ISSUER` specifies the public Auth issuer when the backend reaches Auth through a different internal address, such as `http://kong:8000`. By default the issuer is the Supabase URL followed by `/auth/v1`. Remote Auth connections require HTTPS.

Each business user has a verified `auth_identities` entry with provider type `oidc`, provider key equal to the configured Auth issuer, and provider subject equal to the Supabase user UUID. Identity links are explicit; matching email addresses never create a link. Roles and active status come from the current business user record, while Supabase verifies the access token. Cloud mode rejects legacy administrator API keys and does not fall back to locally signed JWTs.

Verified TOTP factors require an AAL2 session. Sensitive operations use authenticated MFA timestamps with the original 15-minute verification window. Auth failures deny access; temporary Auth failures return a service-unavailable response. Password management and MFA enrollment remain owned by Supabase Auth.
