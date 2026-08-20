# Research decisions and evidence

Status: researched implementation direction\
Evidence date: 2026-08-20

## Research method

The handoff was prepared from:

- The actual Relay repository and targeted Deno validation
- The raw `design/v3/` package and its embedded handoff/accessibility contracts
- Better Auth's current `llms.txt` and official documentation
- BullMQ, Redis, Deno, PostgreSQL, Kysely, AWS/R2, MCP, OpenTelemetry, Grafana,
  Docker, Nginx, GitHub Actions, and Release Please primary documentation
- The redacted VPS Compose/configuration excerpts supplied by the owner

No application implementation was performed. The raw v3 directory remained
unmodified and untracked.

## Decision ledger

| Concern             | Decision                                                                                       | Evidence or caveat                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Runtime             | Deno 2 compiled executable                                                                     | Existing code and production-size goal                                                                       |
| HTTP                | Hono                                                                                           | Existing implementation; Web Standard integration works with Better Auth and MCP                             |
| Domain database     | `pg` pool plus Kysely                                                                          | Better Auth accepts `pg.Pool`; Kysely's PostgreSQL dialect shares the same driver                            |
| Migrations          | Relay-owned checksummed manifest/runner using Kysely transactions and PostgreSQL advisory lock | Kysely's generic migrator does not provide the desired checksum policy or compiled-static manifest by itself |
| Authentication      | Better Auth, Google and GitHub only                                                            | `emailAndPassword` remains omitted/disabled                                                                  |
| Workspaces          | Better Auth organization plugin with personal workspace provisioning                           | Default owner/admin/member roles match Relay                                                                 |
| System admin        | Application-owned `superadmin` grant table                                                     | Must not be a workspace role or PostgreSQL superuser                                                         |
| Queue               | BullMQ OSS, exact version pinned after spike                                                   | Import and compile are encouraging; live Linux/Redis behavior remains a gate                                 |
| Durable queue truth | PostgreSQL job/outbox records                                                                  | BullMQ is delivery transport, not the only record of accepted work                                           |
| Capacity            | Relay-owned atomic Redis scripts                                                               | BullMQ's queue limits do not cover all tool/provider/workspace/fairness rules                                |
| Fairness            | Weighted deficit round robin by scheduling class, then workspace fairness                      | Supports standard/paid/enterprise/internal without starvation                                                |
| Storage             | AWS SDK v3 first candidate behind a narrow adapter                                             | Must pass Deno compile and MinIO/R2/AWS contract suite; Deno-native S3 client is fallback candidate          |
| MCP                 | Official TypeScript SDK v2 split package, Streamable HTTP                                      | Current SDK explicitly supports Deno and Hono                                                                |
| MCP auth            | Direct Better Auth OAuth 2.1 Provider path                                                     | Preserves the approved rule not to depend on the historical MCP plugin abstraction                           |
| Telemetry           | Deno native OTel to Alloy                                                                      | Avoids Node SDK and duplicate providers; native Deno exports traces, metrics, and logs                       |
| Trace backend       | Tempo preferred after live config audit; Jaeger remains smoke-test only                        | Current Jaeger storage is in-memory and loses traces on restart                                              |
| Frontend            | React/Vite reimplementation of v3                                                              | Raw `.dc.html` canvases are review artifacts, not production source                                          |
| Packaging           | Backend image plus web image, one product version                                              | Matches owner deployment topology; supersedes the earlier single-image web assumption                        |
| Release             | Protected main, PR CI, Release Please candidate, tag-driven images                             | Public Relay changelog remains a separate reviewed database publication                                      |
| Pacer               | Deferred                                                                                       | It is process-local/client-oriented and not the distributed backend limiter                                  |

## Researched package snapshot

Versions below were current during research. The implementation agent must pin
exact versions selected by Wave 0 and record any later change.

| Package                  | Researched version                             | Status                                                                                            |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Deno                     | `2.9.4`                                        | Existing repository base                                                                          |
| Better Auth              | `1.7.1`                                        | Import/compile probe reported successful; live PostgreSQL integration still required              |
| Better Auth CLI (`auth`) | `1.7.1`                                        | CLI help under Deno worked; real config generation remains a spike                                |
| `pg`                     | `8.23.0`                                       | Shared Better Auth/Kysely candidate                                                               |
| Kysely                   | `0.29.5`                                       | Domain query/migration candidate                                                                  |
| BullMQ                   | `6.1.2`                                        | Import and compiled module smoke passed; live Redis/container suite remains mandatory             |
| `redis`                  | `6.2.1`                                        | Preferred first BullMQ v6 client-adapter lane                                                     |
| `ioredis`                | `5.11.1`                                       | Parallel compatibility lane and Cluster/Sentinel fallback                                         |
| `@opentelemetry/api`     | `1.x`                                          | Deno native provider requires API only                                                            |
| MCP server               | `@modelcontextprotocol/server@2.0.0`           | Current v2 line supports Deno                                                                     |
| MCP Hono middleware      | `@modelcontextprotocol/hono@2.0.0`             | Optional; avoid mixing incompatible Hono distributions                                            |
| Zod                      | `4.4.3`                                        | Standard Schema implementation candidate                                                          |
| AWS S3 client            | `@aws-sdk/client-s3@3.1113.0` at research time | Must pass compiled contract test; version freshness guard blocked a newer release during research |
| Deno-native S3 fallback  | `jsr:@bradenmacdonald/s3-lite-client@1.0.0`    | Smaller and Deno-native, but less mature                                                          |

## Compatibility status

| Integration                                               | Evidence                       | Gate                                                                                            |
| --------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------- |
| Better Auth core + organizations + `pg` import under Deno | Passed in research probe       | Repeat in repository with frozen lock                                                           |
| Better Auth compiled initialization                       | Passed without live DB         | Connect to PostgreSQL 18 with production TLS/network settings                                   |
| Better Auth CLI help under Deno                           | Passed                         | Generate reviewed SQL from Relay's real config; otherwise use pinned Node tooling container     |
| BullMQ/Redis clients import under Deno                    | Passed                         | Live Redis enqueue/consume/delay/retry/cancel/shutdown                                          |
| BullMQ compiled import                                    | Passed with env/net permission | Linux source-free runtime and fault-injection suite                                             |
| Deno native OTel                                          | Official Deno feature          | Verify compiled app export, route enrichment, shutdown behavior, and Alloy ingestion            |
| MCP SDK v2                                                | Officially supports Deno       | Compile and run Hono/Streamable HTTP conformance suite                                          |
| AWS SDK v3 signing                                        | Research smoke passed          | MinIO/R2/AWS behavior and runtime-size comparison                                               |
| v3 UI                                                     | Raw design evidence exists     | Commit/approval, path normalization, missing assets, contract reconciliation, and fresh exports |

## PostgreSQL and migration decisions

Recommended runtime topology:

```text
one pg.Pool per process
  -> Kysely domain queries
  -> Better Auth direct PostgreSQL adapter
```

Do not create hidden pools in every package. Bootstrap owns pool shutdown.

Use a dedicated schema such as `relay`, with least-privilege roles:

```text
relay_owner      NOLOGIN; owns schema and objects
relay_migrator   LOGIN; deployment-only ability to SET ROLE relay_owner
relay_app        LOGIN; runtime DML only
relay_test       disposable CI equivalent
```

Migration requirements:

- Monotonic immutable IDs
- SHA-256 checksum per migration
- Session-level advisory lock
- One transaction per migration by default
- Applied version, duration, app revision, and timestamp
- Explicit status command
- No automatic migration during API startup
- Expand-and-contract production changes
- Runtime readiness verifies compatible schema without mutating it
- Better Auth generated SQL is reviewed and incorporated into Relay's migration
  history; production does not run an unreviewed schema push

The exact compiled migration-resource mechanism remains a Wave 0 spike. Prefer a
static TypeScript manifest embedded by `deno compile`; do not add broad
filesystem permission solely to enumerate migrations.

## Better Auth decisions

- Mount `auth.handler(c.req.raw)` under `/api/auth/*` before catch-all routes.
- Use exact production origin `https://relay.zaftech.co`.
- Use host-only secure cookies with `SameSite=Lax` for OAuth callbacks.
- Keep CSRF and origin checks enabled.
- Do not enable cross-subdomain cookies.
- Google scopes remain `openid email profile`.
- GitHub requires `read:user user:email` behavior so private primary email
  works.
- Omit `emailAndPassword`; verify email/password endpoints are unavailable.
- Encrypt stored OAuth tokens and disable implicit same-email account linking.
- Use the organization plugin without teams or dynamic roles initially.
- Provision one personal organization/workspace idempotently before the first
  successful session and set it active.
- Treat active organization ID as context, never as authorization proof; query
  current membership for every domain action.
- Keep `testUtils()` in a separate static test-only auth instance and prove the
  production import graph excludes it.

## BullMQ and Redis decisions

BullMQ carries shallow execution tickets containing IDs and policy/trace
references. PostgreSQL stores inputs, state, attempts, and durable results.

Use one BullMQ queue per capacity pool, where a pool represents shared provider
or execution constraints. Do not create a queue per subscription tier.

Do not use:

- Sandboxed processor files or worker threads in the compiled backend
- BullMQ job payloads containing prompts, credentials, or artifact metadata
- BullMQ automatic retries for ambiguous provider operations
- Static queue priorities as the fairness mechanism
- BullMQ private Redis structures from application code

Domain retries create a new dispatch generation after classifying submission
certainty. Capacity deferral changes eligibility and deferral count, not attempt
count.

Redis must use `noeviction`, authenticated access, AOF persistence, monitored
memory, and a tested version compatible with BullMQ. Custom capacity scripts use
Redis server time and same-slot keys.

## Fair scheduling decision

Scheduling classes exist independently from billing plan display names:

```text
standard
paid
enterprise
internal
```

Store the class and policy revision on every accepted job. Production weights
remain configurable. Tests may use illustrative values, but no test fixture is a
commercial promise.

Use work-conserving weighted deficit round robin:

1. Weighted classes compete for service.
2. Workspaces are scheduled fairly inside a class.
3. Jobs remain FIFO inside a workspace.
4. Cost is estimated execution units, not always one job.
5. Idle deficit is capped to prevent an unlimited return burst.
6. Internal traffic has a configurable maximum share.
7. Control-plane maintenance uses a separate small operational lane.

## Storage decisions

The initial storage adapter must support:

- Explicit endpoint, region, credentials, TLS, bucket, path style, and public
  signing endpoint
- MinIO path style
- R2/AWS virtual-host style
- Immutable server-generated keys
- Short-lived presigned PUT and GET
- `HEAD`, delete, and direct worker upload
- Required signed headers
- Portable transfer checksum plus stored SHA-256 provenance

Do not assume ETag is an MD5 digest. Do not rewrite a host after signing. Use a
browser-reachable signing endpoint distinct from the internal service endpoint
when MinIO networking requires it.

The implementation chooses AWS SDK v3 only if the compiled contract suite
passes. Otherwise use the researched Deno-native adapter behind the same
`ObjectStorage` interface.

## MCP decisions

Use the current v2 split SDK, not the v1 `@modelcontextprotocol/sdk` package.
Implementation must pin the supported protocol version and run official
conformance tests.

Relay's direct OAuth-provider rule remains authoritative even though modern
Better Auth also publishes a new MCP convenience package. The implementation
agent must not conflate that package with the historical deprecated plugin or
change the decision without an ADR.

Streamable HTTP requirements include:

- `POST /mcp` and the exact behavior required by the pinned protocol
- Host and present-Origin validation
- Per-request bearer/DPoP verification
- Protected-resource metadata
- No cookie-only MCP authentication
- No workspace trust based solely on a tool argument
- Request-size limits so files never travel inside MCP JSON
- Nginx buffering disabled for request-scoped SSE

CIMD under Deno remains a security spike. Pre-register clients rather than
opening insecure DCR or writing a DNS-rebinding-prone metadata fetcher.

## Native Deno OpenTelemetry decision

Set `OTEL_DENO=true` and export OTLP/HTTP protobuf to Alloy. Import only
`npm:@opentelemetry/api@1` for manual spans and metrics; do not initialize
`NodeSDK` or a second provider.

Deno automatically instruments `Deno.serve`, `fetch`, runtime metrics, and
console logs. Relay still needs:

- Hono route-template enrichment
- Sanitized errors and explicit ERROR status
- PostgreSQL, Redis, BullMQ, S3, provider, reservation, and settlement spans
- Explicit queue context injection/extraction
- Low-cardinality domain metrics
- Graceful-shutdown export verification

Known native limitations include no metric exemplars, developing log support,
raw URL/query attributes on automatic HTTP spans, and incomplete automatic error
status. Alloy must remove queries, raw URLs, secret-bearing attributes, and
high-cardinality BullMQ fields.

## v3 design findings

The owner-supplied v3 package was normalized and committed at `1eb7a3d`. Its
handoff, accessibility contract, tokens, assets, brand, and screens now live
directly under `design/v3/`; raw canvases/runtime/provenance remain alongside
them.

Strengths:

- Registry-first Tools/Runs/Artifacts IA
- Image-tool composer and meter states
- Run/attempt/cancellation/SSE states
- Artifact gallery/share flows
- Tool/provider admin concepts
- Accessibility contract
- New registry, meter, retry, and provenance diagrams

Implementation blockers or corrections:

- The owner authorized v3 as the current implementation reference, while its
  manifest keeps fixture and product-contract exceptions explicit.
- New/changed canvases lack current PNG exports; existing exports are stale.
- Provider/model names, prices, balances, rates, and latencies are fixtures.
- Generated-output image slots contain no real images.
- Official Google/GitHub marks are missing.
- Raw canvases contain thousands of inline styles and inert controls.
- Canvas runtime fetches editor/runtime dependencies and must not ship.
- `component-inventory.md` and some copied canvases retain
  Files/Jobs/storage-era language that the newer handoff supersedes.
- Route and MCP names still encode open decisions.
- Tablet, compact-desktop, 320px, zoom, forced-color, and full mobile coverage
  is incomplete.

Preserve v3 raw files as provenance. The web agent copies approved assets and
reimplements semantic components; it does not mechanically convert the canvas
markup.

## VPS decisions inferred from supplied configuration

- Relay joins external Docker networks; it does not recreate PostgreSQL, Redis,
  MinIO, Nginx, or telemetry services.
- Only Nginx should expose Relay web/API traffic publicly.
- Application telemetry goes to Alloy, not directly to every backend.
- Tempo is the preferred persistent trace backend after its live configuration
  is audited. Current in-memory Jaeger is not production retention.
- Redis needs authenticated health checks, `noeviction`, explicit tested image,
  sufficient memory, and a safer secret configuration.
- PostgreSQL and Redis host ports should be removed or bound to a
  private/loopback interface once Docker-network administration is sufficient.
- Production should not use `docker compose down -v`.
- Infrastructure `latest` tags should become tested pinned versions/digests.
- Nginx must proxy `/api/`, `/mcp`, the exact approved OAuth/OIDC and
  protected-resource metadata locations, and managed share routes to the API,
  with buffering disabled for SSE. It must not capture unrelated `/.well-known/`
  paths such as ACME.

## Primary sources

### Runtime and database

- Deno Node/npm compatibility:
  <https://docs.deno.com/runtime/fundamentals/node/>
- Deno compile: <https://docs.deno.com/runtime/reference/cli/compile/>
- Deno OpenTelemetry:
  <https://docs.deno.com/runtime/fundamentals/open_telemetry/>
- Kysely: <https://kysely.dev/>
- PostgreSQL advisory locks:
  <https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS>
- PostgreSQL roles: <https://www.postgresql.org/docs/18/user-manag.html>

### Better Auth

- LLM index: <https://better-auth.com/llms.txt>
- Hono: <https://better-auth.com/docs/integrations/hono>
- PostgreSQL: <https://better-auth.com/docs/adapters/postgresql>
- Organizations: <https://better-auth.com/docs/plugins/organization>
- Google: <https://better-auth.com/docs/authentication/google>
- GitHub: <https://better-auth.com/docs/authentication/github>
- Test Utils: <https://better-auth.com/docs/plugins/test-utils>
- OAuth Provider: <https://better-auth.com/docs/plugins/oauth-provider>
- Security: <https://better-auth.com/docs/reference/security>

### Queue and storage

- BullMQ connections: <https://docs.bullmq.io/guide/connections>
- BullMQ production: <https://docs.bullmq.io/guide/going-to-production>
- BullMQ graceful shutdown:
  <https://docs.bullmq.io/guide/workers/graceful-shutdown>
- Redis programmability:
  <https://redis.io/docs/latest/develop/programmability/eval-intro/>
- Redis persistence:
  <https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/>
- AWS S3 presigned URLs:
  <https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html>
- R2 S3 compatibility: <https://developers.cloudflare.com/r2/api/s3/api/>

### MCP

- MCP TypeScript SDK v2: <https://ts.sdk.modelcontextprotocol.io/v2/>
- MCP Streamable HTTP:
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http>
- MCP authorization:
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization>
- OAuth protected-resource metadata:
  <https://www.rfc-editor.org/rfc/rfc9728.html>

### Telemetry and delivery

- Prometheus OTLP: <https://prometheus.io/docs/guides/opentelemetry/>
- Loki OTLP: <https://grafana.com/docs/loki/latest/send-data/otel/>
- Grafana Alloy OTLP receiver:
  <https://grafana.com/docs/alloy/latest/reference/components/otelcol/otelcol.receiver.otlp/>
- Tempo: <https://grafana.com/docs/tempo/latest/>
- Release Please action: <https://github.com/googleapis/release-please-action>
- Docker external networks:
  <https://docs.docker.com/reference/compose-file/networks/>
- Nginx proxy module:
  <https://nginx.org/en/docs/http/ngx_http_proxy_module.html>
