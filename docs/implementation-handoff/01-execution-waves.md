# Execution waves and parallel work

Status: ordered implementation plan\
Rule: no lane starts until its declared inputs are merged and its owning paths
are available

## Overall dependency graph

```mermaid
flowchart TD
    V3[Owner pre-step: commit and approve v3]
    W0[Wave 0: parallel compatibility spikes]
    W0I[Wave 0 integration: pin selections and contracts]
    W1[Wave 1: runtime, database, migrations, CI foundation]
    W2A[Wave 2A: Better Auth and workspaces]
    W2B[Wave 2B: observability and audit]
    W2C[Wave 2C: web build and visual foundation]
    W2I[Wave 2 integration: auth plus durable audit]
    W30[Wave 3.0: canonical domain schema and state machines]
    W3A[Wave 3A: BullMQ and capacity]
    W3B[Wave 3B: registry, artifacts, S3, and metering]
    W3C[Wave 3C: changelog and governance]
    W3I[Wave 3 integration: admission and cross-domain constraints]
    W4A[Wave 4A: HTTP and SSE]
    W4B[Wave 4B: MCP OAuth and tools]
    W4C[Wave 4C: public/auth/dashboard UI]
    W4D[Wave 4D: product/admin UI]
    W5[Wave 5: first image-provider vertical slice]
    W6[Wave 6: release, deployment, and production validation]
    W7[Wave 7: multi-provider and commercial expansion]

    W0 --> W0I
    W0I --> W1
    V3 --> W2C
    W1 --> W2A
    W1 --> W2B
    W1 --> W2C
    W2A --> W2I
    W2B --> W2I
    W2I --> W30
    W30 --> W3A
    W30 --> W3B
    W30 --> W3C
    W3A --> W3I
    W3B --> W3I
    W3C --> W3I
    W3I --> W4A
    W3I --> W4B
    W2A --> W4B
    W2C --> W4C
    W2A --> W4C
    W4A --> W4C
    W2C --> W4D
    W4A --> W4D
    W4B --> W4D
    W4C --> W4D
    W3B --> W4D
    W3C --> W4D
    W4B --> W5
    W4C --> W5
    W4D --> W5
    W5 --> W6
    W6 --> W7
```

## Shared ownership rules

The following have one owner at a time:

- Database migration manifest and generated database types
- Public IDs and domain contracts
- Root import map and lock file
- Application command dispatcher
- Web app entry point, router, token layer, and shared primitives
- Production Compose and release workflows

Parallel lanes propose contract changes through the owning lane instead of
editing these files independently. The database owner allocates migration IDs,
updates `packages/database/src/migrations/manifest.ts`, and regenerates database
types. Feature lanes submit schema specifications or reserved migration modules,
then rebase after the owner merges the canonical manifest.

Every lane uses a dedicated branch/worktree. Suggested names are illustrative;
an orchestrator may use equivalent names while keeping write scopes disjoint.

## Owner pre-step — v3 baseline recorded

Completed by `1eb7a3d`: the raw `design/v3/` snapshot is committed and
normalized, and `design/v3/IMPLEMENTATION-MANIFEST.md` records precedence,
routes, states, viewports, fixtures, missing assets, exceptions, and owner
authorization. Web worktrees use this exact commit or a later explicitly
approved amendment.

## Wave 0 — compatibility and contract spikes

Goal: remove runtime uncertainty before permanent dependencies or schemas land.

All technical lanes may run in parallel from the same clean `main`. They use
disposable files or isolated branches and do not each edit the real import map
or lockfile.

| Lane                                                                           | Suggested branch        | Output                                                                              | Required proof                                                                                                              |
| ------------------------------------------------------------------------------ | ----------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Runtime/container                                                              | `impl/00-runtime-spike` | Corrected experimental Dockerfile outside production path or disposable spike files | Compiled API/worker starts in source-free Linux image with only intended permissions                                        |
| Database/auth                                                                  | `impl/00-auth-db-spike` | Disposable Better Auth + `pg` + Kysely probe                                        | PostgreSQL 18 migration generation, compiled auth health, and concurrent idempotent personal-workspace/session provisioning |
| BullMQ                                                                         | `impl/00-bullmq-spike`  | Disposable queue probe                                                              | Live enqueue/consume/delay/retry/cancel/stall/reconnect/SIGTERM in compiled Linux image                                     |
| Storage                                                                        | `impl/00-s3-spike`      | Disposable AWS SDK and Deno-native adapter comparison                               | MinIO presign/PUT/HEAD/GET/delete/checksum/expiry from compiled image                                                       |
| MCP                                                                            | `impl/00-mcp-spike`     | Disposable SDK v2/Hono endpoint                                                     | Official client/conformance, Origin/Host rejection, compiled Deno execution                                                 |
| Telemetry                                                                      | `impl/00-otel-spike`    | Disposable Deno native OTel probe                                                   | API span, custom metric, correlated log reach Alloy and all selected backends                                               |
| Spikes do not create production abstractions. They answer pass/fail questions, |                         |                                                                                     |                                                                                                                             |
| record binary size and permissions, and are removed or isolated before         |                         |                                                                                     |                                                                                                                             |
| production work.                                                               |                         |                                                                                     |                                                                                                                             |

### Wave 0 integration

After spikes report, one integration worktree selects exact successful versions,
records pass/fail evidence, updates the real import map and frozen lockfile, and
publishes shared adapter contracts. It may merge a partial baseline when all
Wave 1 runtime/database prerequisites pass; a failed BullMQ, MCP, storage,
telemetry, or web spike blocks only its dependent lane. No spike branch merges
its experimental lockfile directly.

### Wave 0 gate

- Selected versions are exact and recorded.
- `deno.lock` is reproducible with frozen mode.
- Backend compiles and runs in Linux without Node installed.
- No selected dependency requires unjustified `--allow-run`, broad
  `--allow-read`, or `--allow-ffi`.
- BullMQ and Better Auth operate against real disposable Redis/PostgreSQL.
- Storage adapter is selected through the same MinIO contract suite.
- MCP package/protocol and OAuth-provider path are recorded.
- Telemetry backend choice is recorded: Tempo or a remediated persistent Jaeger.
- Personal workspace provisioning is proven under concurrent session creation.
- v3 path and owner approval are resolved before UI production work.

A failed spike blocks only dependent lanes. For example, UI token extraction may
continue while BullMQ compatibility is unresolved.

## Wave 1 — runtime, database, and delivery foundation

One integration owner establishes shared contracts first:

```text
apps/api/
apps/worker/
packages/config/
packages/contracts/
packages/database/
src/main.ts
Dockerfile
compose.dev.yaml
compose.test.yaml
```

Then these lanes may run in parallel:

### Lane 1A — runtime and configuration

- Fail-fast typed configuration
- API/worker/migrate/healthcheck commands
- Graceful shutdown coordinator
- Correct build metadata
- Source-scoped quality tasks
- Backend image

### Lane 1B — migrations and database

- Pool and Kysely setup
- Checksummed migration manifest
- Advisory lock and migration ledger
- Runtime/migrator roles
- Fresh/status/repeat/compatibility commands

### Lane 1C — CI foundation

- PR source checks
- Disposable dependency services
- Backend compile/container smoke
- Stable aggregate required check
- Secret/dependency/config scanning

### Lane 1D — telemetry bootstrap

- Deno native OTel environment contract
- Manual instrumentation wrapper
- Sanitized logger
- Alloy development receiver/test fixture
- Initial metrics and trace-context helpers

### Wave 1 gate

- Fresh database migrates once; second run is a no-op.
- Modified historical migration fails before DDL.
- API and worker start from compiled backend image.
- `SIGTERM` closes server, pool, and telemetry within grace period.
- Readiness reports dependency and migration state accurately.
- PR CI can run the same commands locally.
- Telemetry outage does not fail application requests.

## Wave 2 — identity, observability, and web foundation

These lanes are parallel after Wave 1 shared infrastructure lands.

### Lane 2A — Better Auth and workspaces

Owned paths:

```text
packages/auth/
apps/api/src/routes/auth/
auth-related migrations and tests
```

Deliver Google/GitHub-only auth, personal workspace provisioning, session
middleware, organization roles, system superadmin grants, and calls to the Wave
1 audit interface. Integrate durable audit persistence after Lane 2B merges.

### Lane 2B — observability and audit

Owned paths:

```text
packages/observability/
packages/audit/
observability tests and deployment templates
```

Deliver domain metrics/spans, redaction, durable audit service, Alloy templates,
dashboards, and alerts without waiting for every domain feature.

### Lane 2C — v3 package and web foundation

Blocked until v3 is committed and approved. Owned paths:

```text
apps/web/
apps/web/src/styles/
apps/web/src/components/ui/
apps/web/src/components/brand/
apps/web/src/components/layout/
apps/web/src/lib/
```

Deliver React/Vite scaffold, router, auth-agnostic session adapter boundary,
design tokens, fonts, approved copied assets, shared primitives, layouts,
browser-test harness, and fixture boundary. Integrate the real Better Auth
client after Lane 2A and the real SSE client after Lane 4A; do not invent those
contracts inside this lane.

### Wave 2 gate

- OAuth-only session integration tests pass without live provider calls.
- First sign-in creates exactly one personal workspace and owner membership.
- Workspace and system roles cannot cross privilege boundaries.
- A short serial Wave 2 integration connects auth/governance actions to the
  transaction-aware audit port after both lanes merge.
- Audit records are durable and immutable by normal application code.
- A trace correlates HTTP, database, log, and audit identifiers safely.
- Web foundation builds without importing design runtime/canvas files or remote
  fonts/scripts.

## Wave 3 — execution, resources, and governance

### Wave 3.0 — canonical domain contract and schema

Before parallel Wave 3 lanes, one contract/database integration owner merges:

- Tool run state machine and canonical `tool_runs` schema
- Job/attempt/outbox state and submission-certainty enums
- Tool/version/provider/capacity-pool references
- Global-tool, workspace-total, and workspace-tool queue/running counters
- Versioned capacity and scheduling policies
- Workspace scheduling-profile assignment controlled only by the server
- Idempotency records
- Usage reservation interface
- Artifact/output-set reference contracts
- Deterministic migration IDs and generated database types

Only after this subwave merges and dependent worktrees rebase may the three Wave
3 lanes proceed in parallel. Identity tables may be created without final
foreign keys when the referenced catalog/artifact table belongs to a parallel
lane; the integration lane adds the reviewed cross-domain constraints.

### Lane 3A — BullMQ, capacity, and fairness

- Transactional outbox relay
- BullMQ adapter and shallow capacity-pool queues
- Worker fenced claims and heartbeats
- GCRA/token bucket and leased concurrency scripts
- Queue depth/age policy
- Cancellation and retry classification
- Weighted fair scheduler with standard/paid/enterprise/internal classes

### Lane 3B — registry, storage, artifacts, and metering

- Tool/tool-version/provider/model catalog
- S3 adapter and direct upload completion
- Artifact/version/output-set model
- Share links and managed delivery
- Entitlement interface
- Estimate/reservation/usage/provider-cost ledgers

This lane may split after shared schema merges:

- `3B-storage`: storage and artifacts
- `3B-catalog`: registry/provider metadata
- `3B-metering`: reservations and ledgers

### Lane 3C — changelog and governance

- Superadmin authorization
- Changelog draft/edit/publish/revision flow
- Legal document and acceptance records
- Governance audit integration

### Wave 3 integration

After 3A/3B/3C merge, one integration worktree adds cross-domain foreign keys
and implements the shared admission service that atomically resolves catalog
binding, authorization, queue counters, reservation, run/job, and outbox intent.
HTTP and MCP lanes depend on this integration commit, not directly on partially
merged 3A/3B schemas.

### Wave 3 gate

- Multiple workers cannot exceed global, workspace-total, or workspace-tool
  limits.
- Weighted fairness converges under saturation without starving any positive
  class.
- Accepted jobs survive Redis/process failures through outbox reconciliation.
- MinIO contract tests pass.
- Cross-workspace storage, catalog, usage, and governance access is denied.
- Usage reservations cannot overspend concurrently.
- Only published changelog entries are public.

## Wave 4 — interfaces and product routes

### Lane 4A — HTTP and dashboard SSE

- Versioned HTTP resources
- Idempotency middleware
- Structured errors
- Run status/cancellation
- Workspace-scoped SSE with reconnect/resync
- Share resolver and short-lived download redirect

### Lane 4B — MCP and OAuth resource server

Before MCP implementation, the auth owner adds the direct OAuth Provider/JWT
configuration, regenerates and reviews the Better Auth schema, obtains a
reserved migration from the database owner, and defines
consent/workspace-selection UI contracts. The MCP lane then adds:

- Better Auth direct OAuth Provider
- Protected-resource and authorization-server metadata
- MCP SDK v2 Streamable HTTP endpoint
- Typed management tools
- Active catalog tool registration
- Scope, audience, current-membership, and entitlement enforcement

### Lane 4C — web route group one

After shared web foundation and API contracts:

Parallel worktrees:

- Landing + public shell
- Sign-in and auth states
- Protected dashboard overview

These three merge and pass browser tests before deeper product routes.

### Lane 4D — web route group two

After shared tool/run/artifact contracts:

Parallel worktrees:

- Tool catalog/detail/composer shell
- Runs/list/detail/SSE states
- Artifact gallery/detail/share
- Usage/settings/profile
- Changelog/docs/status
- Superadmin registry/providers/changelog
- MCP consent, workspace selection, and operator client-registration UI

### Wave 4 gate

- HTTP and MCP use the same application services and policy decisions.
- MCP conformance and OAuth negative tests pass.
- SSE disconnect/reconnect cannot lose durable state.
- Landing/auth/dashboard browser gate passes at required viewports.
- No raw fixture value is presented as a production fact.

## Wave 5 — first image-provider vertical slice

This wave begins only after the owner selects a real provider/model and meter
policy.

Parallel preparation:

- Provider adapter and recorded/sandbox contract tests
- Provider-specific schema extension
- Licensed output fixtures and design replacement assets
- Cost normalization and settlement policy

Then integrate serially:

```text
tool publication
  -> HTTP/MCP invocation
  -> reservation
  -> fair queue
  -> provider submission/recovery
  -> output ingestion
  -> artifact/share URL
  -> settlement
  -> dashboard updates
```

### Wave 5 gate

- End-to-end HTTP and MCP image generation succeeds.
- Multi-output and partial-output behavior is tested.
- Ambiguous submission cannot duplicate provider work.
- Provider/storage failure does not lose accepted state.
- Estimate and final receipt reconcile under approved policy.
- No prompt, provider token, signed URL, or content leaks to telemetry.
- Browser golden path passes keyboard, screen-reader, mobile, and visual checks.

## Wave 6 — release and production validation

Parallel lanes after release policy is approved:

- Protected-main/ruleset configuration
- Release Please and Conventional Commit/PR-title policy
- Backend/web image workflows
- Production Compose/Nginx templates
- Grafana dashboards/alerts and telemetry backend remediation
- Backup, migration, deploy, rollback, and incident runbooks

Integration is serial:

1. Release PR
2. Version/tag creation
3. Build, scan, SBOM, provenance, image publication
4. Digest manifest
5. Manual VPS pull/migrate/up
6. Non-destructive production health/telemetry smoke; rollback and billable job
   rehearsals run in isolated staging unless a separately approved synthetic
   production check is defined
7. Customer changelog draft and superadmin publication

### Wave 6 gate

- Protected branch rejects direct/failed changes.
- Tag builds both images from the same SHA/version.
- Deployment uses digest-pinned images and no application-owned destructive
  volume operation.
- Expand-only schema supports previous-image rollback.
- Telemetry, alerts, backup, restore, and notification delivery are exercised.

## Wave 7 — future expansion

Parallel future work can include:

- Additional providers/models
- Billing and subscription adapters
- Scheduling-weight assignment for paid and enterprise tiers
- Team/invitation UI
- Provider routing and explicit fallback
- Streaming
- Native-dependency worker images
- Multi-region capacity allocation

These reuse the interfaces and policy revisions created earlier; they do not
replace workspace authorization, durable execution, or usage ledgers.

## Merge protocol

For every wave:

1. Rebase worktrees on the wave baseline before review.
2. Merge shared contracts/migrations first.
3. Rebase dependent lanes after contract merge.
4. Merge independent implementation lanes one at a time.
5. Run targeted tests after each merge.
6. Run the full wave gate after the final lane.
7. Record failures not caused by the wave; do not hide or rewrite unrelated
   work.
8. Tag no release until release automation and version policy are approved.
