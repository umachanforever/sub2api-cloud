# Upstream backend

Source: https://github.com/Wei-Shaw/sub2api

Revision: `9c2cca9e627291bc719bada3d57de23b625a4180`

The Go backend is retained to reuse the original administration handlers, services, repositories, schemas, and migrations. Original module paths, source comments, and copyright notices are preserved. Project-specific changes are tracked in Git. See the root LICENSE, COPYING, and NOTICE.

The backend source alone does not change the running deployment. The root Compose file remains the deployment entry point. The architecture boundary is specified in [ARCHITECTURE.md](../docs/ARCHITECTURE.md).

Build the server without embedded frontend assets:

```sh
cd backend
go build ./cmd/server
```

The module declares its required Go toolchain in `go.mod`.

## Integration changes

Management authentication accepts verified Supabase sessions through explicit OIDC identity mappings, with current business roles and native MFA assurance. Supabase configuration is optional for standalone upstream compatibility. The CI management job builds the Go server and verifies the affected authentication paths.
