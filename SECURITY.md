# Security policy

This project is experimental and only the current main branch receives fixes. It has not completed the full upstream feature migration or an independent security audit. Use a separate Supabase project and retain database and encryption-key backups.

## Reporting a vulnerability

Do not open a public issue with exploit details, credentials or sensitive logs. Use the repository's **Security → Report a vulnerability** private reporting feature when enabled. If unavailable, ask maintainers for a private reporting channel without disclosing the vulnerability publicly. There is no promised response time or bounty program.

Include the affected revision, a minimal reproduction with placeholder credentials, expected and actual behavior, and the likely impact. Never send production tokens, encryption keys or account refresh tokens. Rotate any exposed credentials immediately.

## Deployment boundaries

The console container receives only the deployment mode, Supabase URL and publishable / anon key. Service role, deployment tokens, database passwords and account credentials must stay out of browser bundles and container configuration. Backend authorization uses Supabase Auth plus the server-controlled administrator UUID allowlist; frontend flags do not grant authority.

Compose publishes the console on 127.0.0.1 only. The proxy checks local origins and is not a supported public-facing deployment. The Edge Function disables platform JWT checks because it verifies Auth JWTs or gateway API keys itself; do not remove that internal validation. Review database RLS and grants when changing tables or RPCs.
