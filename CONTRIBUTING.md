# Contributing

sub2api-cloud is an independent TypeScript/Supabase port with the original Vue console. Read README.md, docs/PORTING.md and docs/FULL_MIGRATION.md before proposing changes. The remaining migration work is tracked in that checklist; do not describe unsupported upstream features as implemented.

## Development

Use Node.js 24+, pnpm 10, Deno 2, and Supabase CLI. Docker is required for the isolated PostgreSQL integration test. Follow README.md to create `.env.local` and run the console. Use a separate Supabase development project: migrations and `deno task dev` can write data.

Keep changes focused, reuse surrounding conventions, and include a regression test for non-trivial behavior. A backend API change must also update its Vue callers, validation, database permissions/migrations and relevant documentation. Never modify an already applied migration; add a new migration.

Write code comments, commit messages, project descriptions and the primary documentation in English. Keep README.zh-CN.md in sync with README.md; translated UI strings and explicitly localized documents may use their respective languages. Explain free-tier hosting with its quota and network conditions rather than promising unlimited free usage.

Run from the repository root:

```sh
npm test
deno task check
npm run test:database
pnpm --dir frontend --ignore-workspace install --frozen-lockfile --registry=https://registry.npmjs.org
pnpm --dir frontend --ignore-workspace typecheck
pnpm --dir frontend --ignore-workspace build
```

The native management integration suite uses isolated PostgreSQL and Redis containers and a loopback identity fixture. It requires Go from `backend/go.mod`, Docker, Node.js, and Deno; it does not start local Supabase or use a production account:

```sh
(cd backend && go build ./cmd/server)
if ! docker pull public.ecr.aws/supabase/postgres:17.11.0.003; then
  docker pull supabase/postgres:17.11.0.003
  docker tag supabase/postgres:17.11.0.003 public.ecr.aws/supabase/postgres:17.11.0.003
fi
docker pull redis:8-alpine
mkdir -p .local
S2A_AUTH_ACCEPTANCE_FIXTURE=1 S2A_ACCOUNT_VAULT=1 S2A_PERSONAL_HTTP=1 \
  S2A_POSTGRES_IMAGE=public.ecr.aws/supabase/postgres:17.11.0.003 \
  node scripts/accept-management.mjs
```

This suite covers native migrations, Vault credential storage, management CRUD, gateway admission, raw usage persistence, and read-only usage access across enabled accounts. Real Supabase Auth and provider calls are verified separately against the configured project.

For container changes also run `docker build -t sub2api-cloud:test .` and verify the UI and `/api/v1/settings/public` on a temporary loopback port. Clean up the temporary container afterwards.

## Pull requests

Explain the user-visible problem, the resulting behavior, and the checks you actually ran. Note unsupported cases and update the migration checklist when coverage changes. Do not include `.env.local`, credentials, database dumps, personal deployment logs or tokens in diffs, screenshots or test output.

The project uses LGPL-3.0-or-later; preserve LICENSE, COPYING, NOTICE and upstream attribution. By submitting a contribution, you agree to distribute it under the project's license. The vendored frontend is pinned in NOTICE; intentional upgrades must update that reference and document local adaptations.
