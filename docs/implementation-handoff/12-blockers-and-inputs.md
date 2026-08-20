# Blockers, risks, and required inputs

Status: living implementation gate register

## P0 blockers before implementation waves

### Resolve v3 production facts

Current state:

- `design/v3/` is normalized and tracked at `1eb7a3d`.
- `design/v3/IMPLEMENTATION-MANIFEST.md` is the authoritative index.
- The owner authorized v3 as the current implementation reference.

Still required before affected production UI/contracts:

- Resolve fixture providers, prices, route/tool names, and fallback policy.
- Supply real generated-image and OAuth-mark assets before public launch.
- Re-export current screens or establish browser snapshots as the review
  baseline.
- Keep raw canvas/runtime files immutable as provenance.

Web foundation and unaffected routes may proceed; fixture-dependent product
claims and provider-specific flows remain blocked.

### Fix or isolate the backend Dockerfile

Current `deno compile` command is syntactically invalid. Compatibility spikes
may use temporary Dockerfiles, but permanent container/release work is blocked
until this is fixed and validated.

### Approve release/versioning policy

`docs/versioning.md` is still a proposal. Release Please/tag/image publication
cannot be made authoritative until the owner approves:

- First version
- Pre-1.0 feature bump rule
- Tag creator
- Release-PR merge convention
- Public compatibility/deprecation window
- Whether `latest` exists

## Product decisions required before affected features

| Decision                                 | Blocks                                                  | Safe work meanwhile                                                         |
| ---------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| First image providers/models             | Provider adapter, real composer fields, output fixtures | Generic provider contract, queue, storage, catalog                          |
| Meter units/prices/failure charge policy | Production estimates/settlement and UI claims           | Ledger/reservation engine with test policies                                |
| Public share path `/s` vs `/share`       | Public resolver, links, Nginx route, v3 copy            | Share resource/domain behavior                                              |
| HTTP run route `/tool-runs` vs `/runs`   | OpenAPI, web API adapter, docs examples                 | Internal application service                                                |
| Exact MCP tool names                     | Public MCP compatibility contract                       | MCP transport/auth and internal registry                                    |
| Default share expiry/download policy     | Share UI defaults and docs                              | Explicit-policy API/schema                                                  |
| Provider fallback/routing policy         | Multi-provider scheduling/UI                            | Explicit provider selection and no-fallback behavior                        |
| Production scheduling weights            | Commercial fairness behavior                            | Weighted engine with all production classes mapped to equal/default profile |
| Subscription provider/timing             | Paid assignment and billing UI                          | Entitlements, grants, scheduling profiles, usage ledger                     |

Fixtures used in design/tests are not answers to these questions.

## Runtime compatibility blockers

### BullMQ

Must pass live Redis, Linux compiled image, restart, Lua, stall, cancellation,
shutdown, and soak tests. Import-only success is insufficient.

If node-redis and ioredis paths both fail, stop and report. Do not write private
BullMQ structures or silently replace BullMQ.

### Better Auth

Must generate/review schema from the real pinned configuration, connect from the
compiled container to PostgreSQL 18, and prove personal workspace provisioning
under concurrent callbacks.

If CLI loading of Deno config fails, use a pinned Node tooling container for
schema generation; runtime may remain Deno.

### MCP/CIMD

MCP TypeScript SDK v2 implementing protocol revision `2026-07-28` must pass
compiled conformance. Secure CIMD metadata fetch is not available merely by
using normal Deno `fetch`; pre-register clients until a DNS-pinned SSRF-safe
transport is proven.

### S3

AWS SDK v3 must pass MinIO and source-free compile tests. If not, select the
researched Deno-native adapter through the same domain contract. Do not claim
R2/AWS compatibility until their contract suites run.

### Deno native OTel

Verify route enrichment, BullMQ propagation, backend outage behavior, and
shutdown export. Native OTel is developing and has no conventional application
`forceFlush` API.

## VPS inputs required before production configuration

### Observability

Known from supplied evidence: Prometheus has OTLP and remote-write receivers
enabled, Grafana is 12.3.1, Loki accepts OTLP with structured metadata, Jaeger
is in-memory, Alloy exists, and Tempo is listed but unspecified.

Still required:

- `/opt/prometheus/alloy-config.river`, Alloy image/version, startup flags, and
  storage path
- Prometheus image/version, runtime flags/config/rules, exposure, and the actual
  metrics path Alloy currently uses
- `/opt/tempo/docker-compose.yml`, Tempo image/config/storage
- Jaeger exact image/major version
- Loki runtime/build info and schema/config history
- Grafana database backend, plugins, effective config, secret-key handling, and
  datasource/dashboard/alert/contact exports
- Alert ownership: Grafana-managed or Alertmanager
- Expected signal volume, SLOs, retention, and outage tolerance

### Storage

- MinIO Compose/config/network name
- Internal endpoint and browser-reachable signing endpoint
- Bucket and CORS policy
- TLS/certificate arrangement
- Backup/versioning/lifecycle policy

### Delivery

- Docker Hub namespace/repository names, CI push-only token, optional VPS
  read-only pull token, and tag immutability policy
- VPS architecture (`linux/amd64` only or multi-arch images)
- Docker Engine/Compose versions
- Exact external Docker network memberships and aliases
- Complete current Nginx Compose, image/version/modules, included configs, and
  Cloudflare/origin firewall/TLS policy
- Deployment account permissions
- Secret storage approach under `/opt/relay`

### Database/Redis operations

Known from supplied evidence: PostgreSQL 18 is host-published with a custom
`PGDATA`; Redis is host-published, password-protected, and AOF-enabled; Nginx is
containerized; networks are external/shared; deployment is manual under `/opt`.

Still required:

- PostgreSQL exact image/digest, `SHOW data_directory`, effective mounts/UID,
  `pg_hba.conf`, listen interfaces, TLS, connection budget, and PostgreSQL 18
  backup-client version
- Backup/PITR schedule and isolated restore evidence
- Redis exact version, config, memory, ACL/secret method, AOF directory/rewrite,
  backup/restore procedure
- Whether host ports remain necessary for remote administration

Do not put unredacted output in Git.

## v3 inconsistencies to resolve

- Handoff says old content/component files are partly superseded but leaves no
  machine-readable precedence manifest.
- New canvases lack current PNG exports; old exports are stale.
- Provider names, prices, balances, rate limits, latency, uptime, incidents, and
  release content are fixtures.
- No real generated image samples.
- Official OAuth provider marks missing.
- Plus Jakarta Sans 500 is referenced but absent.
- Some storage-first copy and `/dashboard/jobs` links remain.
- Changelog screens retain old role/capability examples.
- Admin lifecycle omits `internal` in places.
- Full component contracts are missing for registry additions.
- Tablet/compact desktop, 320px, 200% zoom, forced-colors, and many mobile
  states are not represented.
- No `/admin/audit` screen despite navigation references.

Engineering can correct semantic/a11y implementation defects, but material
visual/product ambiguity returns to the owner/design agent.

## Infrastructure risks

| Risk                                                    | Consequence                                      | Required mitigation                                                       |
| ------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| Redis unauthenticated healthcheck                       | Container may remain unhealthy                   | Authenticated healthcheck using secret mechanism                          |
| Redis 128 MB/no explicit noeviction                     | OOM or queue-key eviction                        | Size from load; set noeviction; monitor                                   |
| Password in Redis command                               | Secret visible in inspection                     | Mounted config/ACL/secret handling                                        |
| PostgreSQL/Redis host ports                             | Additional attack surface                        | Remove or bind private/loopback; retain firewall                          |
| Floating infrastructure tags                            | Uncontrolled upgrade/config break                | Pin tested version/digest                                                 |
| Jaeger memory storage                                   | Trace loss on restart                            | Tempo or persistent Jaeger                                                |
| Missing Alloy config audit                              | Duplicate/lost/unredacted telemetry              | Export, validate, merge pipelines deliberately                            |
| Loki auth disabled                                      | Anyone on reachable network can query/ingest     | Keep private or add authenticated proxy/tenancy                           |
| Cloudflare IP header trusted by presence                | Spoofable rate-limit identity on direct origin   | Enforce Cloudflare source ranges/real-IP config                           |
| `down -v` deployment                                    | Downtime and future volume deletion              | Pull/migrate/up without volume removal                                    |
| Migration/rollback process not implemented or validated | Deployment can corrupt availability/data         | Implement and rehearse the documented checksummed/expand-contract process |
| PostgreSQL 18 data layout not verified                  | Recreated container may use unexpected storage   | Inspect mounts and `SHOW data_directory` before change                    |
| Static Nginx upstream resolution                        | Recreated Relay container may remain unreachable | Dynamic DNS or mandatory tested graceful reload                           |
| Native OTel URL attributes                              | OAuth codes and signed credentials may leak      | Mandatory Alloy span transforms and canary tests                          |
| Manual Grafana state only                               | Drift and irreproducible alerts                  | Export then provision/version selected resources                          |

## What can be implemented before remaining product decisions

- Runtime/container/configuration
- Database and migration foundation
- Better Auth OAuth/workspaces
- System-superadmin/audit foundation
- BullMQ/Redis compatibility and durable queue
- Capacity limits and weighted scheduling
- S3 adapter against MinIO
- Generic catalog/artifact/share/metering models
- Deno OTel/Alloy integration
- CI and non-release container builds
- MCP transport/auth foundation with pre-registered test client
- Web shared foundation after v3 is committed/approved

## What must remain blocked

- Real image-provider integration
- Production rates, prices, and quotas
- Paid/enterprise scheduling assignment
- Public tool names and compatibility promise
- Final share/run URL contracts
- Subscription checkout/billing
- Public provider output examples
- Release tag/image publication before versioning approval and implementation/
  validation of the documented draft-release/image-promotion workflow
- Production telemetry routing before live Alloy/Tempo review
- Public launch claims, uptime, and changelog entries

## Decision recording

When an item is resolved:

1. Add the decision to the owning canonical document or an ADR under
   `docs/adr/`.
2. Record date, owner, and alternatives considered.
3. Update affected schemas/contracts/design examples.
4. Add or update tests before implementation merges.
5. Remove the blocker here only after the evidence commit is reachable from
   main.
