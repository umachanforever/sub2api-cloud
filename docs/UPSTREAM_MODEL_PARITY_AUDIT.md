# Gemini and Antigravity cloud parity audit

Audit date: 2026-11-02. Scope: model discovery and Gemini/Antigravity inference in the independent Supabase gateway.

## Reference

The upstream `main` revision inspected was [`4a4a83ee5ec86b19d3a2dd9b6471de5128963bec`](https://github.com/Wei-Shaw/sub2api/commit/4a4a83ee5ec86b19d3a2dd9b6471de5128963bec), committed on 2026-11-02, with `backend/cmd/server/VERSION` set to `0.2.19`. The local NOTICE pins `dece26153621959ccd7635814f4b2d08304e681a`.

The inspected upstream Gemini model catalog, native Gemini handler, Antigravity retry service, native Gemini forwarder, and credits-overage implementation match the retained local Go files byte for byte. Those Go files do not serve cloud inference: `supabase/functions/sub2api/` implements that path independently. Updating the retained source alone does not give the Edge Function equivalent behavior.

The findings below describe the baseline at cloud commit `e915bd9`, before the corrective implementation described at the end of this document.

## Confirmed gaps at baseline

### P1: Gemini thinking variants are not resolved in the cloud path

Upstream `backend/internal/service/antigravity_gemini_thinking_variant.go:120` resolves a bare name such as `gemini-3.8-flash` to an available account-mapped thinking variant. It respects explicit aliases, supports self-mappings, derives the preferred variant from `thinkingLevel` or `thinkingBudget`, and falls back through available variants. The native forwarder calls this resolver in `antigravity_gateway_gemini.go` before constructing the request.

Cloud selection in `supabase/functions/sub2api/proxy.ts:378` performs account alias lookup but has no equivalent variant resolution. `antigravity_oauth.ts` sends the selected model unchanged.

A no-network invocation of the actual TypeScript request builder produced:

```json
{"requested":"gemini-3.8-flash","thinkingLevel":"low","forwardedModel":"gemini-3.8-flash"}
{"requested":"gemini-3.8-flash","thinkingLevel":"high","forwardedModel":"gemini-3.8-flash"}
```

When the upstream exposes only suffixed variants, this can make a valid public alias fail and then disappear from the verified catalog. This is a request-routing defect, not evidence that the whole model family is unavailable.

### P1: Smart retries and model-level backoff are not ported

Upstream `antigravity_gateway_retry.go:103` parses 429/503 responses, retry delays, and model-capacity conditions. It supports bounded retries, model-level rate limits, account switching, and a single-account retry path.

Cloud `antigravity_oauth.ts:92` tries each configured endpoint once. It does not parse model-capacity errors or retry delays. Normal inference in `proxy.ts` subsequently applies an account-wide cooldown for 429 and some other statuses. The recently added model-probe entry point suppresses that cooldown for discovery only; it does not provide upstream-equivalent model-level scheduling for ordinary requests.

Consequently, a temporary capacity failure can be treated as an unavailable model, and normal requests for one model can still affect other models sharing the account.

### P1: On-demand availability filtering hides inconclusive results

`model_availability.ts` allows 10 seconds per probe and 45 seconds per listing, with two workers. Every candidate without a successful result is omitted, including candidates never reached before the listing deadline. Transient failures are also omitted. These are stricter conditions than upstream's normal inference retry path.

The probe uses eight output tokens, which is a weak test for thinking and image models. Its success predicate checks for a nonempty `candidates` or `choices` array; it does not require user-visible output or a successful terminal reason. This can both omit working models after inconclusive probes and accept incomplete responses.

A filtered catalog therefore means "passed this probe under its current limits", not "all other models are unsupported". The number of excluded models is not a reliable measure of provider support or migration completeness.

### P2: Account-tier endpoint selection is missing

Upstream `antigravity_gateway_retry.go:58` selects production or daily endpoints according to environment overrides and the account's paid-plan status. Its source documents authentication failures caused by sending production tokens to the wrong endpoint.

Cloud generation always starts at the daily endpoint. Its endpoint fallback excludes HTTP 401, so it cannot reliably recover from this mismatch. The inspected live account reports a Pro plan; this gap is not established as the cause of that account's recent failures, but it affects parity for other account tiers.

### P2: Signature recovery and thinking-budget rectification are missing

Upstream native Gemini forwarding retries signature-related HTTP 400 responses after cleaning thought signatures. The Claude path also has staged signature recovery and thinking-budget rectification.

The cloud transport has schema cleaning and protocol conversion, but no corresponding response-driven recovery. History and tool requests can fail even when a one-turn text probe succeeds. This gap alone does not explain failures of a simple history-free probe.

### P2: Optional AI Credits fallback is missing

Upstream `antigravity_credits_overages.go:172` can retry a confirmed quota-exhaustion response with `enabledCreditTypes`, subject to account overage settings and credit availability. The cloud transport has no equivalent branch.

This matters only for accounts that explicitly enable overages. The inspected live account has no enabled overage setting, so this is a parity gap rather than an established cause of its filtered models. Porting it must preserve the existing opt-in requirement.

## What is already present

- Public model catalogs and default account alias mappings are retained/generated from Go sources.
- OAuth refresh coordination, basic endpoint fallback, protocol conversion, usage recording, and streamed responses exist in the cloud path.
- The Cherry Studio versionless Gemini-path authentication defect was reproduced and fixed separately. It is not a provider model-support failure.
- No evidence from this audit establishes that every filtered model should be restored, or that every 429 can be recovered. Real plan entitlements, quota exhaustion, and unsupported models still apply.

## Recommended correction order

1. Port thinking-variant selection with differential cases against the retained Go resolver, including explicit mappings and self-mappings.
2. Port account-tier endpoint selection, bounded capacity retries, and model-scoped scheduling/backoff. Respect the hosted worker deadline rather than copying an unbounded retry policy.
3. Replace the binary availability verdict with explicit verified, temporarily limited, invalid, and unverified outcomes. Keep actual-call verification, but do not present timeout or budget exhaustion as confirmed unsupported status. Use protocol-appropriate probes and validate completion/output.
4. Add signature/budget recovery and account-opted-in credits fallback.
5. Compare the same accounts and requests through the Go implementation and cloud gateway before changing the visible catalog again. Include bare/suffixed Gemini names, native and compatible protocols, streaming, tools/history, and transient errors.

## Corrective cloud implementation

The independent TypeScript runtime now includes:

- Bare Gemini thinking-variant resolution, including explicit aliases, self-mappings, exact variant lookup, longest wildcard precedence, native thinking configuration, Claude budgets, and compatible-protocol reasoning effort. Database admission also accepts bare names backed only by configured variants.
- Production-first requests for free/unknown tiers and daily-first requests for Pro/Ultra and legacy paid tier IDs. Catalog discovery remains production-first. HTTP 401 still enters coordinated credential refresh rather than blind retries.
- Bounded 429/503 recovery: parse structured model errors and retry delays, retry short capacity failures in place, and persist longer model backoffs in `account.extra.model_rate_limits`. The scheduler applies the requested/upstream model cooldown and mapped aliases without cooling unrelated models. Genuine authentication failures retain ordinary account handling. At most five transport attempts are made per provider send; short retries are admitted only during the first six seconds. Existing request cancellation/deadlines still apply.
- Response-driven Gemini signature cleaning and staged Claude recovery. Claude thinking becomes text first; historical tools become text only after another signature failure. Budget recovery reduces thinking budget within the caller's existing output cap instead of silently raising the cap to 64,000 tokens.
- AI Credits fallback only after confirmed quota exhaustion and only when the account explicitly enabled overages. Confirmed credit exhaustion disables that fallback for five hours without disabling ordinary inference. Discovery probes do not opt into paid overage fallback.
- Actual-call catalog verification with a 1,024-token output cap, native low/disabled thinking where supported, a 20-second per-model deadline, and a 50-second listing deadline with two workers. A model must produce visible text, image data, or a tool call and a successful terminal reason. Empty, reasoning-only, truncated, and blocked responses do not qualify. Cached positive results are retained before new probes, and remaining candidates rotate across listings. The `x-s2a-model-verification` response header counts `verified`, `temporary`, `unsupported`, and `unverified` outcomes. HTTP 400/422 are temporary rather than long-lived unsupported verdicts.

Verification remains deliberately conservative: only successful probes appear in the filtered catalog. Temporary quota/capacity failures and models not reached before the deadline remain absent until a later successful probe. Cache and rotation are worker-local, so a cold worker repeats verification; this is not a durable provider-wide model-health database. The changes do not grant additional provider entitlements, automatically enable overage spending, or establish that every upstream model is usable by every account.

Validation includes TypeScript checking, transport/proxy and availability regression tests, and isolated PostgreSQL management acceptance covering lease/version ownership, restricted RPC grants, durable model cooldowns, alias admission, unrelated models, credits opt-in, and finished-lease rejection. The retained Go source and upstream reference are unchanged.

## Validation and deployment record

On 2026-11-02, the complete Node suite passed (999 passed, two skipped), `deno check supabase/functions/sub2api/app.ts` passed, and management acceptance passed against an isolated Supabase PostgreSQL container with account Vault enabled. `deploy/personal-gateway.sql` and the `sub2api` Edge Function were deployed to project `grajkelwrpewoxuzeqwa`.

Live post-deployment inference returned HTTP 200 with usable `OK` text for Gemini 3 Flash over native JSON, Chat Completions, and Cherry Studio's versionless native streaming path, plus Gemini 3.8 Flash using both the bare name with low thinking and the explicit `-low` variant. These checks confirm those requests on the configured live account; they do not establish availability of every catalog entry or every provider feature.
