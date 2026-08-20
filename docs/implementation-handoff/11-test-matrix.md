# Cross-phase test and acceptance matrix

Status: required behavior with implementation flexibility

## Test policy

- Tests prove invariants, not implementation trivia.
- A lane may replace a prescribed test with an equivalent or stronger one only
  when the integration owner approves the substitution and the change/proof are
  documented.
- Automated pull-request tests use disposable PostgreSQL, Redis, and MinIO and
  never call production services.
- Destructive recovery/load rehearsals run against an isolated staging clone.
- Production validation is explicitly approved, bounded, and non-destructive
  (health, version, routing, telemetry canary, and notification checks).
- Google/GitHub provider calls are mocked in PR CI; staging smoke uses dedicated
  test credentials.
- Provider contract tests use official sandbox/recorded sanitized fixtures.
- Raw design exports are not subjected to source formatting.
- Flaky tests are quarantined only with an owner, issue, reason, and removal
  date; they do not silently disappear from required gates.

## Evidence per worktree

Every implementation worktree reports:

```text
owned paths
base commit
commits created
commands run
pass/fail counts
known unrelated failures
migration/config changes
security or operational impact
```

The integration owner reruns the wave gate after merge.

## Wave 0 compatibility matrix

| Spike             | Minimum evidence                                                                                                                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Better Auth       | Organization-enabled compiled handler, PostgreSQL 18 schema/connection, `/api/auth/ok`, concurrent first-session provisioning creates one workspace/owner mapping, active organization assignment, partial recovery, no recursion/deadlock, clean shutdown |
| BullMQ            | Enqueue/consume/delay/retry/events/cancel/SIGTERM/restart with real Redis from compiled Linux image                                                                                                                                                        |
| Redis clients     | node-redis and ioredis lanes; connection/auth/reconnect/Lua/Streams/blocking behavior                                                                                                                                                                      |
| Kysely/migrations | Compiled static manifest, advisory lock, checksum, transaction rollback                                                                                                                                                                                    |
| S3                | Presign/PUT/HEAD/GET/delete/checksum/expiry/path-style against MinIO; candidate size and permissions                                                                                                                                                       |
| MCP               | Official TypeScript SDK v2 client and `2026-07-28` protocol conformance, Host/Origin/auth failures, compiled Hono endpoint                                                                                                                                 |
| OTel              | Deno native trace/metric/log through Alloy; sanitized route enrichment; outage behavior                                                                                                                                                                    |

The React/Vite build/token extraction test belongs to Wave 2C after v3 is
committed and approved, not to Wave 0.

A failed spike produces a written blocker and exact reproduction. It does not
get converted into a permanent dependency with a TODO.

## Wave 1 foundation matrix

### Configuration

- Required/optional/default behavior
- Invalid URL, integer, duration, byte limit, enum, boolean
- Production placeholder secret rejection
- Secret redaction in parse errors and logs
- Build metadata consistency

### Migrations

- Fresh database
- Repeat/no-op
- Concurrent migrators
- Checksum mismatch
- Reordered/missing historical migration
- Transaction rollback
- Lock-holder process death
- Runtime DDL denial
- Schema behind/ahead compatibility

### Process/container

- API/worker/migrate/healthcheck commands
- Source-free compiled image
- Non-root/read-only filesystem
- Minimum permissions
- Live versus ready behavior
- SIGTERM within grace
- Database/Redis unavailable startup and recovery

### Telemetry foundation

- API span with route template
- Correlated sanitized log
- Custom metric arrival
- Collector unavailable does not fail request
- Graceful shutdown export behavior recorded

## Wave 2 auth/governance matrix

### OAuth

- Only Google and GitHub
- Email/password endpoints absent
- Exact callbacks, scopes, state, PKCE
- Verified/private provider email handling
- Invalid issuer/audience/signature/profile
- Missing/mismatched state
- Untrusted origin/callback
- Provider denied/unavailable
- Implicit linking rejected and explicit linking unavailable safely until its
  later service/UI lane is approved
- Secure cookies and session revocation

### Workspaces

- Exactly one personal workspace under concurrent first sign-in
- Owner membership and active workspace
- Partial provisioning recovery
- Existing sign-in no duplicate
- Owner/admin/member matrix
- Last-owner protection
- Removed membership immediate denial
- Cross-workspace resource isolation

### Superadmin/audit

- No workspace role implies system permission
- Grant/revoke requires operator/current superadmin path
- Grant/revoke audited
- Revocation immediate
- Fresh-session enforcement
- Audit rows immutable to runtime role

### Web foundation

- Build/container
- Router and error boundaries
- Session provider/protected route
- Deterministic token generation
- Self-hosted assets only
- Shared primitive unit/axe tests
- No imports from design runtime/canvas files

## Wave 3 execution/resource matrix

### Outbox and BullMQ

- Crash before/after Redis publication
- Duplicate publication
- Lost Redis ticket reconciliation
- Stalled worker recovery
- Deterministic ticket generation
- No prompt/secret in Redis payload
- Graceful shutdown and forced deadline

### Capacity and fairness

- Exact global-tool, workspace-total, and workspace-tool queue/running limits
  under concurrency
- Queue age expiry before provider call
- GCRA/token-bucket no overshoot
- Leased concurrency no overshoot
- Lease expiry/fencing stale-worker rejection
- Provider cooldown monotonic extension
- Redis restart conservative recovery
- Deferral does not increment attempts
- Weighted shares converge within agreed tolerance
- No starvation
- Empty-class work conservation
- Idle-deficit cap
- Variable-cost fairness
- Internal maximum share
- Multiple scheduler replicas, dispatch-lease crash recovery, and persistent
  deficit/cursor recovery
- Maximum-cost valid job eventually accumulates enough deficit

### Catalog

- Lifecycle transition matrix
- Published immutability
- Handler/schema validation
- Provider/model/binding enable/disable
- Superadmin authorization/audit
- No executable code upload

### Storage/artifacts/share

- MinIO full adapter contract
- Selected R2/AWS sandbox contract before claiming compatibility
- Presigned headers/checksum/expiry/method
- Immutable key behavior
- CORS
- Completion verification
- Multi-output/partial output
- Version concurrency
- Soft delete/purge/restore
- Share expiry/revoke/exhaust/concurrent **resolution** count, or proxied actual
  download count when that stronger mode is selected
- Pending-upload expiry, quota release, and orphan cleanup
- No durable provider/storage URL

### Metering

- Estimate policy
- Concurrent reservation
- Idempotent settlement
- Failure/cancel/timeout/partial behavior
- Provider cost/customer usage separation
- Adjustment append-only history
- Historical policy explainability

## Wave 4 interface/UI matrix

### HTTP

- Validation and sanitized errors
- Pagination stability
- Idempotent replay/conflict
- Workspace isolation/non-disclosure
- Accepted queue versus capacity rejection
- Cancellation races
- Direct-upload-only file path
- Managed URL authorization

### SSE

- Workspace auth
- Initial durable state plus event
- Reconnect/resync
- Pub/Sub loss recovery
- Permission removal
- Heartbeat
- Nginx no-buffer first-event timing
- Accessible announcements in UI

### MCP

- Official TypeScript SDK v2 client and conformance for protocol revision
  `2026-07-28`
- POST JSON/SSE and notification `202`; GET/DELETE and session headers match the
  pinned modern protocol rather than legacy assumptions
- `MCP-Protocol-Version`, Accept negotiation, cancellation, and unsupported
  method behavior
- Host/Origin/body-size rejection
- Exact protected-resource and authorization metadata, canonical resource,
  `resource` parameter, token audience, and `WWW-Authenticate` challenge
- Cookie-only, issuer, audience, expiry, scope failures
- Current membership/resource authorization
- No sticky replica dependence unless protocol requires it
- Typed management schemas and a deterministic test-only tool that is provably
  excluded from production catalog/config; real image-tool schema waits for Wave
  5
- DPoP and CIMD suites if enabled

### Landing/auth/dashboard

Viewports:

```text
320
390
768 or 834
1024
1440
200% zoom
forced colors
reduced motion
```

Test:

- Landmarks/headings
- Keyboard/focus
- Official provider marks
- Auth state matrix
- Protected dashboard
- Workspace/superadmin visibility
- No horizontal overflow
- No fake product claims
- Axe serious/critical zero
- Approved screenshot comparison

## Wave 5 image-tool matrix

Golden path:

```text
discover
-> contract/meter
-> configure
-> estimate/reserve
-> idempotent submit
-> fair queue
-> provider
-> output ingestion
-> artifact/share
-> settlement
-> live UI
```

Required variants:

- Single and multi-output success
- Partial output
- Validation/policy/safety rejection
- Provider rate limit and cooldown
- Timeout
- Pre-submission retry
- Confirmed submission retrieval retry
- Ambiguous submission reconciliation
- Storage failure after retrieval
- Cancel before provider consumption
- Cancel after billable consumption
- Completion-wins cancellation race
- Insufficient allowance
- Permission removal
- Provider/model retired between saved config and execution

Security assertion: prompts, provider credentials, bearer tokens, signed URLs,
and bytes are absent from logs/traces/queue payloads.

## Wave 6 release/operations matrix

### CI/release

- Branch protection and required checks
- Release Please bump behavior
- Tag validity/reachability/version consistency
- Tag-created workflow trigger identity and protected-tag bypass
- Failure after the first final image tag is promoted causes no rebuild; retry
  verifies the existing tag digest, promotes only the missing tag, rejects a
  conflict, and publishes a matching two-image manifest
- Backend/web same SHA/version
- Image labels, non-root, SBOM, provenance, vulnerability gate
- Digest manifest

### Deployment

- Compose render, project-name lock, deployment lock, architecture/disk/digest/
  backup checks, and external-network preflight before mutation
- Pull-only production model
- Effective migration command assertion and migration success/failure
- Bounded, version-supported `up --wait`
- Nginx syntax/reload and upstream resolution after API recreation
- Exact web/API/MCP/OAuth-metadata/share/SSE routing through Nginx and
  Cloudflare
- OAuth callback query/Location/Set-Cookie preservation with code/state absent
  from Nginx access/error logs, available Cloudflare logs, Loki, and traces
- SSE first-event latency, heartbeat beyond every idle timeout, reconnect, and
  `Last-Event-ID` behavior when supported
- No unintended host ports
- Selected-version and digest deployment
- Previous-image rollback after additive migration

### Telemetry/alerts

- Three-signal telemetrygen through Alloy using the actual exporter URLs
- Exactly-once signal canaries prove no duplicate scrape/export/log paths
- Compiled Relay API/worker correlation
- Sensitive canary absence from logs and spans, including inbound OAuth query,
  route/object-key paths, and outbound presigned URL attributes
- Untrusted external trace headers cannot choose the accepted trace ID or
  parent-based sampling decision
- Prometheus cardinality review
- Loki label review and log-to-trace link
- Trace persistence across backend restart only after persistent Tempo or Jaeger
  is selected; the supplied in-memory Jaeger is expected to fail persistence
- Alloy/backend outage behavior
- Rule syntax/unit tests
- Real notification delivery

### Recovery

- PostgreSQL 18 image/mount/`SHOW data_directory` verification, current-version
  dump tools, backup age, and isolated full restore rehearsal
- Redis ACL-authenticated healthcheck, AOF rewrite/restart/restore, and durable
  outbox recovery after deliberate loss
- Private Prometheus/Loki/Alloy/Redis endpoints unreachable from web/Nginx and
  unrelated containers
- Grafana 12.3.1 provisioning/rollback in an isolated clone
- MinIO/object restore procedure
- Failed migration behavior
- Broken release rollback rehearsal in isolated staging, or separately approved
  synthetic production procedure
- Operator runbook walkthrough

## Performance and soak

Before production image tools:

- Sustained API/MCP request load
- Queue saturation at every class
- Worker restart loop
- Redis restart and latency injection
- PostgreSQL connection exhaustion protection
- S3 slow/error injection
- Provider `429`/timeout/error mix
- SSE reconnect storm
- Telemetry backend outage
- At least one execution longer than multiple BullMQ lock periods

Collect CPU, memory, binary startup, queue lag, database pool, Redis
connections, telemetry queue, and storage/provider latency. Set production
defaults from measurements rather than guesses.

## Acceptance record

Each phase stores a concise artifact or PR comment containing:

```text
commit SHA
test commands
pass counts
container digests when relevant
migration version
known limitations
owner-approved exceptions
```

A manual check without recorded evidence does not become a permanent release
gate claim.
