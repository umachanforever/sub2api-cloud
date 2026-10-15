# Service Responsibilities

The project reuses the original Go management backend and Vue console with a Supabase-hosted AI request path.

| Area | Runtime |
| --- | --- |
| Console sign-in and identity | Supabase Auth |
| Account, group, and key administration | Local Go service |
| Provider credentials | Supabase Vault |
| API key authentication and account reservations | Cloud RPCs over native Go records |
| Provider requests and streaming | Supabase Edge Function |
| Automatic credential refresh | Supabase Edge Function with database refresh locks |
| Token usage, quota headers, and request errors | Canonical PostgreSQL records |
| Management interface and reports | Original Vue console and Go APIs |

The personal gateway operates without commercial balance debits or subscription settlement. Original management features remain in the Go backend; they do not introduce a workstation dependency into cloud AI requests.

For deployment commands and configuration, see [Deployment](DEPLOYMENT.md). The shared record and credential boundaries are described in [Architecture](ARCHITECTURE.md). Upstream route references are retained in `upstream-route-inventory.json`.
