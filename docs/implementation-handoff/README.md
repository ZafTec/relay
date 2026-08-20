# Relay implementation handoff

Status: implementation plan only; no production implementation is included\
Research date: 2026-08-20\
Design baseline: `1eb7a3d` (`design/v3/` normalized and tracked)\
Audience: implementation orchestrator and independent worktree agents

## Purpose

This directory is the implementation source for the next engineering agent. It
turns Relay's product architecture, the v3 design export, and the approved VPS
constraints into dependency-ordered work with parallel lanes and test gates.

The implementation agent must not interpret this as permission to skip product,
security, migration, or design gates. Where this handoff says **spike**, the
result is evidence used to choose an implementation. Where it says **blocked**,
the agent records the missing input and proceeds only with independent work.

## Authority order

When sources disagree, use this order:

1. [`../product-and-roadmap.md`](../product-and-roadmap.md) for product
   invariants.
2. This implementation handoff for implementation order and researched technical
   decisions.
3. [`../../design/v3/HANDOFF.md`](../../design/v3/HANDOFF.md) and
   [`../../design/v3/ACCESSIBILITY.md`](../../design/v3/ACCESSIBILITY.md) for
   visual and interaction intent.
4. Specialized Relay documents such as [`../changelog.md`](../changelog.md),
   [`../legal.md`](../legal.md), and [`../versioning.md`](../versioning.md).
5. Historical design versions `design/v1/` and `design/v2/` for provenance only.

A conflict must be recorded and resolved; an agent must not silently choose the
most convenient source.

## Non-negotiable decisions

- Runtime: Deno 2, compiled for production.
- HTTP: Hono and Web Standard `Request`/`Response`.
- Database: PostgreSQL 18 is durable authority.
- Queue: BullMQ over Redis, behind Relay adapters and a mandatory compiled-Deno
  compatibility gate.
- Capacity: Redis-backed global per-tool limits, provider limits, leased
  concurrency, cooldowns, and weighted fair scheduling.
- Saturation: valid work queues by default, bounded by per-tool/global and
  per-workspace depth plus maximum wait time.
- Authentication: Better Auth, Google and GitHub OAuth only. No email/password,
  magic-link, or public credential signup.
- Tenancy: Better Auth organizations exposed as Relay workspaces; roles `owner`,
  `admin`, and `member`; platform `superadmin` remains separate.
- Storage: S3-compatible adapter for MinIO, Cloudflare R2, AWS S3, and
  equivalent services.
- MCP: official TypeScript SDK v2 with Streamable HTTP. Use Better Auth's direct
  OAuth 2.1 Provider path; do not build on the historical deprecated MCP plugin.
- Telemetry: Deno native OpenTelemetry to Grafana Alloy, then Prometheus, Loki,
  and a persistent trace backend.
- Pacer: excluded from backend and MVP. It may be reconsidered for
  dashboard-only pacing later.
- Frontend: React/Vite implementation derived from v3, not generated canvas
  code.
- Deployment: separate backend and web images sharing one product release
  version. The backend image runs `api`, `worker`, and `migrate` commands.
- Public product changelog: database-published after superadmin review; never
  raw Git commits.

## Current repository reality

Implemented now:

- Deno workspace
- Hono shell
- `relay api` and `relay worker` dispatch
- Basic live/readiness/version/root API routes
- Three API tests

Not implemented:

- PostgreSQL or migrations
- Better Auth or OAuth
- Redis/BullMQ
- Durable jobs or capacity policies
- S3 storage
- Tool registry, artifacts, metering, MCP, SSE, audit, or OpenTelemetry
- React/Vite frontend
- CI/CD or release automation

Known blockers:

- `Dockerfile` is syntactically invalid around `deno compile`.
- `/health/ready` performs no dependency checks.
- Repository-wide `deno fmt --check` includes raw design exports.
- `design/v3/` is tracked at `1eb7a3d`, normalized to the same root layout as
  v1/v2, and owner-authorized as the current implementation reference.
- Fixture providers/prices, route names, current exports, missing
  generated-image assets, and other manifest exceptions remain unresolved
  production facts.

## Handoff files

| File                                                                 | Purpose                                                                                       |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`00-research-decisions.md`](00-research-decisions.md)               | Evidence, selected technologies, compatibility status, source links, and known contradictions |
| [`01-execution-waves.md`](01-execution-waves.md)                     | Dependency graph, worktree lanes, parallel work, merge order, and phase gates                 |
| [`02-runtime-database.md`](02-runtime-database.md)                   | Deno runtime, configuration, PostgreSQL, Kysely, migrations, roles, and containers            |
| [`03-auth-workspaces.md`](03-auth-workspaces.md)                     | Better Auth, social OAuth, personal workspaces, authorization, and auth tests                 |
| [`04-queue-capacity-scheduling.md`](04-queue-capacity-scheduling.md) | BullMQ, outbox, Redis limits, leases, retries, cancellation, and weighted fairness            |
| [`05-domain-storage-metering.md`](05-domain-storage-metering.md)     | Tool registry, provider catalog, artifacts, S3, share links, entitlements, and usage ledgers  |
| [`06-http-mcp-events.md`](06-http-mcp-events.md)                     | HTTP contracts, MCP TypeScript SDK v2, OAuth resource protection, idempotency, and SSE        |
| [`07-observability-audit.md`](07-observability-audit.md)             | Deno OTel, Alloy pipelines, metrics/logs/traces, audit, dashboards, and alerts                |
| [`08-web-v3.md`](08-web-v3.md)                                       | Raw v3 cleanup, React decomposition, parallel UI routes, accessibility, and visual tests      |
| [`09-ci-release-deployment.md`](09-ci-release-deployment.md)         | Protected main, CI, Release Please, Docker Hub, Compose, Nginx, migration, and rollback       |
| [`10-vps-remediation.md`](10-vps-remediation.md)                     | Concrete remediation for the supplied VPS Redis/PostgreSQL/Grafana/Nginx stack                |
| [`11-test-matrix.md`](11-test-matrix.md)                             | Cross-phase unit, integration, failure-injection, E2E, security, and operations gates         |
| [`12-blockers-and-inputs.md`](12-blockers-and-inputs.md)             | Decisions and live configuration still required before specific phases                        |

## How an implementation agent should work

1. Start from a clean, current `main`.
2. Never modify or stage unrelated user work. Preserve raw v3 canvas/runtime
   files as provenance and implement only through reviewed copies under
   `apps/web`.
3. Complete Wave 0 spikes before selecting versions or adding permanent package
   dependencies.
4. Give one worktree ownership of shared contracts and migrations. Parallel
   agents must not invent competing schemas.
5. Keep write sets disjoint inside each parallel wave.
6. Run the lane's targeted tests before committing.
7. Review the lane from the root worktree before merge.
8. Merge in the order defined in
   [`01-execution-waves.md`](01-execution-waves.md).
9. Run the wave-level integration gate after every merge group.
10. Update [`../implementation-status.md`](../implementation-status.md) with
    observed evidence, not planned behavior.

## Acceptance flexibility

Tests in this handoff specify required behavior, not mandatory test-framework
syntax. An agent may substitute an equivalent or stronger test only with
integration-owner approval and a record of:

- Why the original form did not fit the implementation
- What invariant the replacement proves
- How the test fails when the behavior is broken

An agent may not weaken a gate merely because a dependency is difficult to test.
Unproven behavior remains blocked or experimental.

## Completion definition

Relay is not complete when pages render or a provider returns an image. A
release candidate requires:

- Reproducible compiled backend and static web images
- Reviewed migrations and tested rollback compatibility
- OAuth-only sign-in and workspace isolation
- Durable, idempotent asynchronous execution
- Global capacity limits and fair scheduling under concurrency
- Durable artifact ingestion and managed delivery
- Accurate usage reservation and settlement
- Authenticated MCP and HTTP contracts
- Trace/log/metric correlation without secret leakage
- Tested CI, release, deployment, backup, and incident procedures
- Browser accessibility and responsive validation against the approved v3 design
- No unresolved P0/P1 item in `12-blockers-and-inputs.md`
