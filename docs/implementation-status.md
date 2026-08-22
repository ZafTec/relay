# Relay implementation status

Status: repository audit\
Verified: 2026-08-21\
Design baseline: `1eb7a3d` (`design/v3/` normalized and tracked)

## Summary

Relay is currently a small, healthy Deno/Hono process scaffold, a real
PostgreSQL 18 foundation (pool, checksummed migrator, health checks), and
extensive planning and design material. It is not yet an authenticated storage
service, tool registry, MCP server, job system, or image-generation platform.

The implemented code proves:

- The workspace resolves and type-checks.
- One executable can dispatch an API process, a worker process, or the
  `migrate up`/`migrate status` commands.
- The Hono API serves basic health, version, and root API routes, and
  `/health/ready` reflects real PostgreSQL reachability instead of always
  reporting `ok`.
- The placeholder worker starts and waits for shutdown; the API now has a real
  graceful-shutdown path too (`SIGTERM` drains the server, then closes the
  database pool).
- The checksummed migrator applies migrations transactionally under a
  session-level advisory lock, refuses tampered history, and enforces the
  `relay_owner`/`relay_migrator`/`relay_app` privilege boundaries from
  `02-runtime-database.md` -- proven against live PostgreSQL 18, not just
  type-checked.
- BullMQ (via ioredis, per ADR 0002) transports outbox-relayed execution tickets
  from PostgreSQL to a worker, and a Redis-backed capacity coordinator enforces
  concurrency leases and GCRA rate limits with all-or-none, non-consuming denial
  -- proven live against compiled-binary BullMQ and real Redis.
- The full write path this all serves is implemented and proven end to end:
  `admitToolRun` performs the durable "Acceptance transaction" (idempotency,
  counter locking, run/job creation, outbox insert) and `claimJobForDispatch`/
  `deferJob`/`heartbeatJob` implement the worker-side fenced claim and
  capacity-deferral cycle -- neither is wired into an HTTP route or the
  `apps/worker` process yet (no auth/routing exists to call admission from, no
  provider exists yet for a claimed job to call).
- A tool catalog now backs what `admitToolRun`'s `tool_version_id`/`tool_id`
  previously accepted as opaque strings: `packages/catalog` implements the full
  tool lifecycle (register -> version -> publish -> deprecate/disable ->
  retire), superadmin-gated and audited, with publish refused for a handler that
  isn't registered in the code-first handler registry.
- `admitToolRun` now calls into both real subsystems instead of trusting
  caller-supplied IDs: it authorizes the creator against real `getMembership`
  workspace membership, requires the tool version to be an actually-published
  `relay.tool_versions` row on a non-disabled/non-retired tool, and resolves its
  capacity pool by reading a real `relay.tool_provider_bindings` row -- closing
  the gap this file flagged after Wave 3.0 ("no application code validates
  tool_version_id"). Routing selection beyond "lowest routing_order enabled
  binding" and real provider/model fixtures are still Wave 5's.

The container build defect, the repository-wide quality-task scope defect, and
the readiness false-positive defect (for its one wired dependency, PostgreSQL)
recorded in the 2026-08-20 audit are fixed and verified (see Validation evidence
and Known defects and risks). Targeted source checks and all API/database tests
pass; the database tests require `DATABASE_URL` (`compose.dev.yaml`) and are
skipped, not failed, without it.

## Status vocabulary

| State       | Meaning                                                                     |
| ----------- | --------------------------------------------------------------------------- |
| Implemented | Working source exists and was validated for its current narrow contract.    |
| Scaffolded  | A process, type, route, or boundary exists but lacks production behavior.   |
| Documented  | The target behavior is described but no meaningful implementation exists.   |
| Missing     | No implementation was found.                                                |
| Blocked     | Work should not begin until an explicit dependency or decision is resolved. |

## Capability matrix

| Area                           | State                                     | Repository evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Gap to target                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deno workspace                 | Implemented                               | `deno.json`, workspace package manifests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Add web app and future domain packages without losing compiled-runtime checks.                                                                                                                                                                                                                                                                                       |
| Process dispatcher             | Implemented                               | `src/main.ts` dispatches `relay api`, `relay worker`, and `relay migrate up\|status`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Add `relay healthcheck live\|ready` one-shot commands for the container healthcheck.                                                                                                                                                                                                                                                                                 |
| HTTP server                    | Implemented                               | `apps/api/src/server.ts` starts Hono with `Deno.serve`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Add middleware, graceful shutdown, proxy policy, security headers, and production routing.                                                                                                                                                                                                                                                                           |
| API shell                      | Scaffolded                                | `apps/api/src/app.ts` exposes four basic routes and JSON errors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | No domain endpoints, auth, request IDs, rate limits, or contract validation.                                                                                                                                                                                                                                                                                         |
| Liveness                       | Implemented                               | `GET /health/live` returns service and build data                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Current behavior is adequate only as process liveness.                                                                                                                                                                                                                                                                                                               |
| Readiness                      | Implemented                               | `GET /health/ready` runs an injected `checkReadiness`; wired to a real `select 1` database check in `server.ts`, returns 503 with a sanitized reason when the database is unreachable and 200 when it is reachable, verified live                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Wire Redis, storage, and migration-compatibility checks as those packages land.                                                                                                                                                                                                                                                                                      |
| Build information              | Scaffolded                                | `/version`; `APP_VERSION` and `GIT_SHA` in `packages/config/src/index.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | No CI injection, build timestamp, OCI labels, MCP metadata, or telemetry resource fields.                                                                                                                                                                                                                                                                            |
| Runtime configuration          | Scaffolded                                | Port, build fields, and fail-fast typed `DatabaseConfig`/`RedisConfig` (URL scheme, pool size, timeouts) in `packages/config/src/index.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Storage, auth, OAuth, provider, and telemetry settings are not loaded or validated yet.                                                                                                                                                                                                                                                                              |
| Worker process                 | Scaffolded                                | `apps/worker/src/worker.ts` logs startup, waits for a signal, and logs shutdown -- not yet wired to `packages/queue`'s BullMQ workers or the outbox relay poll loop                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | No leases, jobs, heartbeats, attempts, handlers, retries, or cancellation dispatch loop.                                                                                                                                                                                                                                                                             |
| Shared contracts               | Scaffolded                                | `packages/contracts/src/index.ts` defines six job statuses, health/build types, and `ReadinessCheck`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | No IDs, schemas, errors, tool, run, artifact, usage, or event contracts.                                                                                                                                                                                                                                                                                             |
| Structured logging             | Scaffolded                                | API and worker write a few JSON console records                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | No common logger, request/trace context, redaction, levels, sinks, or schema tests.                                                                                                                                                                                                                                                                                  |
| PostgreSQL                     | Implemented (foundation)                  | `packages/database`: one `pg.Pool` per process, a checksummed migrator (session advisory lock, `SET ROLE relay_owner`, transactional apply, ledger), and health checks -- verified against live PostgreSQL 18 (fresh apply, idempotent re-run, checksum-mismatch rejection, rollback-on-failure, concurrent-migrator convergence, and `relay_app` role-boundary denial). Four real migrations applied: Better Auth core (reviewed `auth@latest generate` output, schema-qualified into `auth`), `relay.personal_workspaces`, `relay.system_role_assignments`, and Better Auth's `rateLimit` table.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | No tool/run/artifact/usage domain schema yet (Wave 3.0). Kysely typed `Database` interface not started -- migrations use raw SQL via `sql.raw`, not the query builder.                                                                                                                                                                                               |
| Redis                          | Implemented (foundation)                  | `packages/queue/src/redis.ts`: `createRedisConnection` (named `ioredis` import, `maxRetriesPerRequest: null` per ADR 0002); `RedisConfig` in `packages/config`. Verified live against `compose.dev.yaml` Redis 8.2 (password-protected, AOF-enabled).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | No production TLS/ACL config; readiness route doesn't check Redis yet.                                                                                                                                                                                                                                                                                               |
| Queue                          | Implemented (foundation)                  | `packages/queue`: BullMQ 6.1.2 + ioredis 5.11.1 per [ADR 0002](adr/0002-bullmq-redis-client-selection.md) (Wave 0 spike passed every "Compatibility" acceptance test, including a compiled `deno compile` binary against live Redis). `bullmq.ts` (one queue per capacity pool), `tickets.ts` (`ExecutionTicket`, deterministic ticket IDs), `outbox-relay.ts` (`FOR UPDATE SKIP LOCKED` claim, at-least-once publish, lease-based retry). Verified live end-to-end: outbox row -> claim -> BullMQ publish -> worker delivery -> `published_at`; failed-publish retry; lease-expiry reclaim -- 3 tests, stable across repeated runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Not wired into `apps/worker` yet (no dispatch loop, no capacity-coordinator integration, no heartbeat/fencing on delivery). Weighted/variable ticket cost not modeled.                                                                                                                                                                                               |
| Capacity coordinator           | Implemented (foundation)                  | `packages/capacity`: `CapacityCoordinator` domain interface (`acquireExecutionLease`, `renewExecutionLease`, `releaseExecutionLease`, `acquireSubmissionPermit`, `setProviderCooldown`, `inspectCapacity`) over atomic Lua scripts -- expiring sorted-set concurrency leases (all-or-none across global-tool/pool/workspace-total/workspace-tool scopes) and GCRA rate limiting with extend-only provider cooldown. Verified live against Redis: 7 tests covering the limit boundary, all-or-none non-consumption on a later denial, renew/release, expiry reclaim, GCRA allow/deny/refill timing, cooldown blocking and its extend-only guarantee, and `SCRIPT FLUSH` recovery.                                                                                                                                                                                                                                                                                                                                                                                                                                             | Unweighted only (`relay.execution_capacity_leases.units` not honored -- every lease costs 1 regardless of estimated job cost). No weighted fair scheduler (deficit round robin across scheduling classes) yet -- that's the rest of Wave 3A.                                                                                                                         |
| Tool registry                  | Implemented (catalog lane, foundation)    | `packages/catalog`: `registerTool`/`createToolVersion`/`publishToolVersion`/`setToolLifecycle` over new `relay.tools`/`relay.tool_versions` schema (migrations 0013-0017, applied live), enforcing the full `draft -> internal -> published -> deprecated -> retired` lifecycle plus the `published`/`deprecated` <-> `disabled` branch, each mutation superadmin-gated and audited. Publish is refused for a `handler_key` absent from the code-first `HandlerRegistry`; `validateCatalogHandlers` reports published versions whose handler later went missing. Verified live: 8 tests covering permission denial, sequential version numbering, unknown-handler refusal, publish activating `active_version_id`, every lifecycle edge (including skip-rejection and re-enable), and the handler-validation report.                                                                                                                                                                                                                                                                                                         | No HTTP/MCP route calls this yet. `relay.providers`/`provider_models`/`tool_provider_bindings`/`routing_policies`/`routing_decisions` tables exist (same migration set) but have no service layer -- routing selection is Wave 3B integration/Wave 5's, once a real provider exists to route to. Storage/artifacts and metering lanes (rest of Wave 3B) not started. |
| Provider/model catalog         | Scaffolded (schema only)                  | `relay.providers`, `relay.provider_models`, `relay.tool_provider_bindings`, `relay.routing_policies`, `relay.routing_decisions` (migrations 0014-0017) -- bigint-identity, operator-only catalog tables, matching `relay.capacity_pools`'s precedent. `admitToolRun` now reads `tool_provider_bindings` live to resolve a capacity pool for admission, so this schema is no longer inert -- it gates real admissions today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Still no repository/curation service or routing-selection logic (routing is always "lowest `routing_order` enabled binding", not policy-driven yet), and no real provider fixtures. Blocked on selecting real provider integrations (Azure AI Foundry gpt-image-2/FLUX.2-pro, GCP Gemini per the owner's decision) before fixture data becomes real.                 |
| Tool runs                      | Implemented (domain logic, no HTTP route) | `packages/queue/src/admission.ts`'s `admitToolRun` now fully implements the "Acceptance transaction" including step 2 ("Authorize workspace, tool version, provider binding"): real `getMembership` workspace-membership check, a `relay.tool_versions` lookup requiring `published_at` set and the owning tool not `disabled`/`retired`, and provider-binding resolution via `relay.tool_provider_bindings` (lowest `routing_order`, enabled) -- callers no longer pass `toolId`/`capacityPoolId` directly, both are derived from the resolved catalog data. `packages/queue/src/dispatch.ts` implements "Worker claim and fencing" (fenced claim with `dispatch_generation`/`lease_epoch`, heartbeat, capacity-deferral back to `queued` with a bumped generation and fresh outbox event). Verified live: 8 admission tests (including the new not-a-member/unavailable-tool-version refusals), 6 dispatch tests, plus one full pipeline test (admission -> outbox relay -> BullMQ ticket -> worker delivery) -- all against a real workspace member and a real published, bound catalog tool version, not opaque strings. | Not called from any HTTP handler (no auth/routing exists to call it from yet). Scheduling-class authorization and step 6 ("reserve usage") remain deferred -- `relay.workspace_scheduling_profiles` (fair scheduler) and metering don't exist yet. What happens after a capacity lease is acquired (the actual provider call) is Wave 5's, not started.              |
| Retry safety                   | Documented                                | Target rules are in `product-and-roadmap.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | No submission-certainty or reconciliation implementation.                                                                                                                                                                                                                                                                                                            |
| S3-compatible storage          | Missing                                   | No SDK, adapter, bucket checks, object-key policy, or MinIO tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Implement deployment-configured storage behind domain interfaces.                                                                                                                                                                                                                                                                                                    |
| Artifacts and versions         | Missing                                   | No schema or services                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Add durable artifacts, immutable versions, provenance, output sets, retention, and purge.                                                                                                                                                                                                                                                                            |
| Managed URLs and share links   | Missing                                   | No resolver, token model, or route                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Keep durable Relay links separate from short-lived S3 signatures.                                                                                                                                                                                                                                                                                                    |
| Image generation               | Missing                                   | No provider SDK or handler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Build one provider end-to-end, then add adapters through the same contract suite.                                                                                                                                                                                                                                                                                    |
| Metering                       | Missing                                   | No estimate, reservation, usage, cost, or settlement code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Required before production provider execution.                                                                                                                                                                                                                                                                                                                       |
| Entitlements and subscriptions | Documented                                | Architecture planning exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Build capability/limit checks independently from future billing provider.                                                                                                                                                                                                                                                                                            |
| Better Auth                    | Implemented (foundation)                  | `packages/auth`: OAuth-only config (Google/GitHub), mounted at `/api/auth/*`, session-hook-driven personal workspace provisioning, superadmin grant/revoke -- verified live against PostgreSQL 18 (14 integration tests: no-recursion/concurrency-safe workspace provisioning, membership/last-owner checks, superadmin audit-sink) and via the compiled API (`/api/auth/ok` 200, email/password 400)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Wave 4B adds the jwt()/mcp() plugins for MCP OAuth per ADR 0001. Browser sign-in UI is still Wave 4C/v3. Rate-limit trusted-proxy config waits on the real Nginx network (VPS input, still unresolved).                                                                                                                                                              |
| Google OAuth                   | Implemented (foundation)                  | Configured with `openid email profile` scopes, no Drive/Gmail/offline access; config validated fail-fast (`packages/config`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Real callback flow untestable without a live Google OAuth app -- provider callback tests per 03-auth-workspaces.md (issuer/audience/signature fixtures) not yet written.                                                                                                                                                                                             |
| GitHub OAuth                   | Implemented (foundation)                  | Configured with `read:user user:email` scopes so private primary email resolves; config validated fail-fast                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Same real-callback-flow gap as Google OAuth above.                                                                                                                                                                                                                                                                                                                   |
| Workspace tenancy              | Implemented (foundation)                  | `packages/auth`: personal workspace per user (Better Auth organization + `relay.personal_workspaces` mapping), `getMembership`/`canRemoveMember` (owner/admin/member), `relay.system_role_assignments` kept separate from workspace roles -- all verified live. `getMembership` is now also load-bearing outside `packages/auth` itself: `admitToolRun` calls it directly to authorize every admission.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | No HTTP routes enforce this yet (Wave 4A); workspace-switching/invitations/teams UI intentionally out of MVP scope per 03-auth-workspaces.md.                                                                                                                                                                                                                        |
| MCP server                     | Missing                                   | No MCP SDK, `/mcp`, discovery routes, or tools                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Use official SDK and Better Auth OAuth Provider, not the deprecated MCP plugin.                                                                                                                                                                                                                                                                                      |
| Dashboard and landing          | Missing                                   | V3 design is tracked; no `apps/web` exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Implement from v3 while respecting manifest exceptions and the engineering handoff.                                                                                                                                                                                                                                                                                  |
| SSE live updates               | Missing                                   | No event route or fan-out                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Implement durable fetch plus workspace-scoped SSE reconnect/resync.                                                                                                                                                                                                                                                                                                  |
| OpenTelemetry                  | Missing                                   | No SDK initialization or exporter configuration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Add API/worker resources, trace propagation, metrics, and redaction.                                                                                                                                                                                                                                                                                                 |
| Audit log                      | Implemented (foundation)                  | `packages/audit`: insert-only `relay.audit_events` (migration 0005), `recordAuditEvent` with idempotency-key dedup and credential-shaped-key redaction; `relay_app` has UPDATE/DELETE revoked on the table at the DB level. Wired into superadmin grant/revoke via `withTransaction` (fail-closed: audit-insert failure rolls back the grant). Verified live: 6 tests covering durable insert, idempotent retry, non-dedup of distinct events, redaction, and the immutability revoke.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Not yet wired into workspace/role changes, tool publish, share links, or changelog actions -- those land as each domain lands. OTel/metrics/traces/Alloy (the rest of Wave 2B) not started; blocked on live VPS Alloy config (unresolved input).                                                                                                                     |
| Changelog                      | Documented                                | `docs/changelog.md` contains workflow and schema                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | No database, routes, public pages, admin pages, or superadmin checks.                                                                                                                                                                                                                                                                                                |
| Legal acceptance               | Documented                                | `docs/legal.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | No legal-document or acceptance records.                                                                                                                                                                                                                                                                                                                             |
| CI                             | Missing                                   | No `.github/workflows` files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Add PR quality, integration, container, and security jobs.                                                                                                                                                                                                                                                                                                           |
| CD                             | Missing                                   | No Docker Hub workflow                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Add immutable-SHA publication on merge and release-tag publication.                                                                                                                                                                                                                                                                                                  |
| Compose app definition         | Scaffolded                                | `compose.yaml` defines API and worker using external configuration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | No migration service, dependency health checks, immutable image pin, or production override.                                                                                                                                                                                                                                                                         |
| Container image                | Implemented                               | `Dockerfile:14-15` continuation fixed; the real multi-stage `docker build` was run unmodified and produces a working, non-root, source-free runtime image                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Wave 1 still needs `migrate`/`healthcheck` commands added to the image and a broader permission review.                                                                                                                                                                                                                                                              |
| Product release tags           | Missing                                   | No Git tags were present in the prior audit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Approve SemVer policy before official release automation.                                                                                                                                                                                                                                                                                                            |

## Implemented HTTP surface

| Route               | Actual behavior                               | Coverage         |
| ------------------- | --------------------------------------------- | ---------------- |
| `GET /health/live`  | Always returns API `ok` and build fields      | One passing test |
| `GET /health/ready` | Always returns API `ok`, no dependency checks | No test          |
| `GET /version`      | Returns configured version and revision       | One passing test |
| `GET /api/v1`       | Returns app name and `ok`                     | No test          |
| Unknown route       | Returns a stable `not_found` JSON envelope    | One passing test |

No authenticated, MCP, tool, run, artifact, upload, download, share, usage, SSE,
admin, changelog, or provider route is implemented.

## Validation evidence

Commands run on 2026-08-20 (baseline audit, before the fixes below):

```sh
deno fmt --check apps packages src
deno lint apps packages src
deno check src/main.ts
deno test --allow-env apps/api/src/app_test.ts
```

Result: passed. Deno checked 11 source files, linted 7 files, and ran 3 tests
with 3 passed and 0 failed.

Repository-wide command (as it existed before the fix):

```sh
deno task check
```

Result: failed in `deno fmt --check`. The command included design documents,
SVGs, and the untracked newer design-system bundle. The earlier audit reported
50 unformatted files out of 89. With the later raw v3 export present, a
subsequent research pass reported 91 unformatted files out of 141 before lint,
type check, or tests could run. This was a task-scope problem, not evidence that
application source failed formatting.

Container command (as it existed before the fix):

```sh
docker build --progress=plain -t relay:audit .
```

Result: failed before build execution:

```text
Dockerfile:15
unknown instruction: src/main.ts
```

The multiline `RUN deno compile` command lacked a trailing continuation after
`--output /out/relay`.

### Re-verification on 2026-08-21, after the P0/P2 fixes

`deno.json`'s `check`/`fmt`/`lint` tasks now pass `apps packages src`
explicitly. Repository-wide command:

```sh
deno task check
```

Result: passed — `deno fmt --check`, `deno lint`, `deno check src/main.ts`, and
`deno test --allow-env` (3 passed, 0 failed) all succeeded against the scoped
source tree, with no `design/` or `docs/` files touched.

`Dockerfile:14-15` now reads `--output /out/relay \` followed by `src/main.ts`
on its own continuation line. First checked with an equivalent
`deno compile --allow-env --allow-net --output dist/relay src/main.ts` run
outside Docker (no daemon available yet at that point) — produced a working
binary serving `/health/live`, `/version`, `/api/v1`, and the `not_found`
envelope correctly.

### Re-verification with a live Docker daemon, same day

A Docker daemon was later brought up in this environment (`dockerd` starts
successfully here). The real command was then run directly, unmodified:

```sh
docker build --progress=plain -t relay:audit .
```

This reached the `deno compile` build step (proving the earlier Dockerfile
syntax fix correct) but failed there only because this sandbox's build
containers cannot reach the outbound network proxy this session otherwise runs
through — a documented environment limitation (`/root/.ccr/README.md`'s "docker
build / docker run" section), not a Dockerfile defect. Per that doc's own
suggested workaround, a disposable Dockerfile copy (`--network host`, plus
`DENO_CERT` pointed at the session's CA bundle) was built and discarded without
modifying the tracked `Dockerfile`:

```sh
docker build --network host -f Dockerfile.spike -t relay:spike .
docker run -d --name relay-spike -p 18080:8000 -e PORT=8000 relay:spike api
```

Result: the full multi-stage build succeeded end-to-end — build stage compiled
the binary, runtime stage produced a `debian:bookworm-slim`-based, source-free
image running as `65532:65532` (non-root). The running container served
`/health/live`, `/version`, and the 404 envelope on the mapped port exactly as
the direct `deno compile` run did. Image and spike files were removed after
verification; only the real `Dockerfile` fix (already committed) remains in the
repository.

## Known defects and risks

### P0 — Container build is broken (fixed 2026-08-21)

`Dockerfile:14` was missing a line continuation before `src/main.ts`, so Docker
parsed the source path as an unknown instruction. A trailing `\` was added after
`--output /out/relay`. Verified two ways: `deno compile` with the same flags
outside Docker, and — once a Docker daemon was available in this environment —
the real, unmodified `docker build` end to end (see Validation evidence). Both
produce a binary/image that serves `/health/live`, `/version`, `/api/v1`, and
the 404 envelope correctly; the image runs as non-root (`65532:65532`). Wave 0's
runtime/container spike proof is satisfied for this defect.

### P1 — Readiness can produce a false positive (database check fixed 2026-08-21)

`/health/ready` now runs a real `select 1` against PostgreSQL via an injected
`checkReadiness` function and returns `503` with a sanitized reason when it
fails; verified live by stopping the compose Postgres container mid-run and
observing `/health/ready` flip to `503` while `/health/live` stayed `200`. Redis
and storage checks are not implemented yet -- add them as those packages land
(Wave 3A/3B) so this defect isn't closed until all required dependencies are
covered.

### P1 — Configuration presents more capability than runtime supports

The example environment file documents future integrations, while the runtime
loader currently reads only application name, port, version, and revision. A
misconfigured production process will not fail fast for missing durable services
because those services are not wired at all.

### P1 — No durability exists behind the worker contract

The worker's shutdown behavior is only a signal wait. There is no queue lease,
checkpoint, heartbeat, or recovery behavior to make long-running work safe.

### P2 — Repository quality command includes generated design material (fixed 2026-08-21)

`deno task check`, `fmt`, and `lint` now pass explicit `apps packages src` paths
instead of scanning the repository root, so they no longer touch `design/`,
`docs/`, or other non-application files. Verified: `deno task
check` passes
cleanly (fmt, lint, type check, and all 3 tests) against this scoped target.

### P2 — Test confidence is intentionally narrow

The three tests cover liveness, version output, and 404 shape only. There are no
configuration edge tests, readiness tests, process smoke tests, worker tests,
container tests, or dependency integration tests.

## Reviewer feedback response (2026-08-22)

An external review of the Wave 3A/3B work (`packages/database`,
`packages/queue`, `packages/capacity`, `packages/catalog`, `packages/auth`)
listed 20 "blocking defects reproduced or verified." Each was independently
re-verified against live PostgreSQL/Redis before being treated as real; one (the
generic-`DATABASE_URL` risk in database integration tests) was confirmed by
directly reproducing it against this session's own dev database while fixing the
ledger-privilege item, then fixed for real rather than just theoretically.

### Fixed, live-verified, and covered by new/updated tests

- **`relay_app` could modify/delete `relay.schema_migrations`.** Fixed via an
  explicit `REVOKE INSERT, UPDATE, DELETE ... FROM relay_app` in
  `ensureLedgerTable`, matching the existing `relay.audit_events` pattern.
- **Database integration tests could drop the real migration ledger.**
  `migrator_test.ts`'s destructive tests now require a dedicated
  `MIGRATOR_TEST_DATABASE_URL` pointing at a disposable `relay_test` database
  (`scripts/dev/postgres-init/002-test-database.sql`) and refuse to run unless
  the target database name ends in `_test`.
- **`admitToolRun` deadlocked under `poolMax: 1`.** Membership is now checked
  through the transaction's own client, not the outer pool.
- **Idempotency replay ran before authorization; concurrent identical requests
  could throw a raw unique-violation.** Membership is now checked first on every
  call; the final idempotency insert uses `ON CONFLICT DO NOTHING` with an
  explicit rollback-and-reresolve path.
- **Queue limits were caller-supplied.** `admitToolRun` now resolves them from
  `relay.capacity_policies`, with a conservative built-in default when a tool
  has no policy configured yet.
- **Queue counters only ever grew.** `claimJobForDispatch`/`deferJob` now shift
  `queued_count`/`running_count` on claim and on capacity deferral, in the same
  fixed lock order admission uses.
- **Capacity deferrals consumed a real attempt and could be republished
  immediately.** `deferJob` now reverses the claim's provisional
  `attempt_count`/`job_attempts` bookkeeping (capacity waiting is not an
  attempt, per the handoff doc) and gives the `job.deferred` outbox event the
  job's own `eligible_at` instead of defaulting to `now()`.
- **Capacity Lua scripts trusted the worker's clock.** Every script (lease
  acquire/renew, GCRA rate limiting, cooldown extension) now calls Redis `TIME`
  internally instead of taking "now" as an argument.
- **Published tool versions and routing decisions were mutable by `relay_app`.**
  A trigger freezes every behavior-defining `tool_versions` column once
  `published_at` is set (lifecycle columns `deprecated_at`/`retired_at` stay
  open for a mutator that doesn't exist yet); `relay.routing_decisions` lost
  `UPDATE`/`DELETE` the same way `audit_events`/`schema_migrations` did.
- **Readiness only proved connectivity.** `checkMigrationLedgerHealth` reads the
  ledger (read-only, so it works under `relay_app`) and applies the same
  order/checksum/completeness check `migrateUp` enforces, reporting drift as
  `error` instead of staying silently "ready."
- **No repo-level LF policy.** Added `.gitattributes` (`text=auto
  eol=lf`).
- **The 40-passed/59-ignored gap had no teeth.** `deno task check:live` refuses
  to run at all unless `DATABASE_URL`/`MIGRATOR_TEST_DATABASE_URL`/ `REDIS_URL`
  are all set, then fails if anything is still reported `ignored`. Currently:
  107 passed, 0 ignored.
- **Several Wave 3 FKs were missing.** `job_attempts.routing_decision_id` was
  `text` against `routing_decisions.id bigint`; altered in place (column was
  always `null` in practice) and FK'd.
  `tool_runs`/`execution_jobs.tool_version_id` predate the catalog they
  reference and were left unconstrained; both FK'd to `tool_versions` now.
- **Personal-workspace provisioning didn't heal a missing membership row.** A
  crash between claiming the `personal_workspaces` mapping and creating the
  `auth.member` row could permanently lock a user out of a workspace
  `getMembership` would never recognize them in. Every call now checks and, if
  needed, recreates that membership row, including the already-mapped fast path.

### Investigated, found substantially mitigated by existing config — not changed

- **OAuth does not enforce a currently verified provider email.** Traced through
  Better Auth 1.7.1's actual OAuth callback path (not just its docs):
  `@better-auth/core`'s `google`/`github` provider adapters compute
  `emailVerified` correctly from the real provider signal (Google's
  `email_verified` OIDC claim; GitHub's per-address `verified` flag off
  `/user/emails`, matched to the specific email being used). Relay's own
  `account.accountLinking.enabled = false` (`packages/auth/src/auth.ts`)
  independently blocks every implicit-linking path in `oauth2/link-account.mjs`
  regardless of `emailVerified` — a sign-in that matches an existing user's
  email returns `"account not linked"`, never a session for that user. A
  brand-new user created from an unverified provider email is stored with the
  correct `emailVerified: false`; nothing in Relay currently trusts a user's
  email for anything security-sensitive (authorization runs entirely off
  `userId`/`auth.member`, never email). Residual risk is forward-looking, not
  current: **any future feature that trusts `auth.user.email` for something
  security-relevant (workspace invitations by email, notification delivery
  treated as proof of ownership, support-driven account actions) must check
  `emailVerified` before honoring it.** Flag this explicitly in that feature's
  own review rather than treating today's OAuth config as needing a change.

### Deferred — large enough to need their own implementation pass, not a patch

- **Better Auth's organization routes bypass audit coverage.** Member/role/
  invitation mutations reachable through the `organization` plugin's own routes
  (`/api/auth/organization/*`) don't go through `packages/audit`'s
  `recordAuditEvent`. Closing this needs Better Auth's hook surface
  (`databaseHooks`/plugin `after` hooks per mutation) wired per route, each
  mapped to the right `AuditEventInput` shape and target type — real, scoped
  work, not a one-line fix, and not started.
- **Usage reservation is absent.** `admitToolRun`'s step 6 ("Reserve usage")
  stays deferred to metering, which doesn't exist as a package or schema yet.
  Nothing to wire it into until that lands.
- **`apps/worker` is still a signal-waiting placeholder.** BullMQ consumption,
  cancellation, retries, graceful shutdown, reconciliation, and fair scheduling
  are all unwired — this is the largest single gap left after this pass and the
  natural next-wave target, since `packages/queue`'s dispatch/outbox-relay and
  `packages/capacity`'s coordinator (both exercised end-to-end by tests, per
  Validation evidence) are exactly the pieces a real worker composes.
- **Redis state loss / reconciliation.** A lost Redis dataset can drop
  already-published BullMQ tickets and reset provider capacity state with
  nothing to detect or repair it. Meaningfully depends on the worker existing
  first (reconciliation is something a worker's startup/sweep does), so it's
  grouped with that gap rather than fixed standalone.
- **Weighted standard/paid/enterprise/internal scheduling.** Needs
  `relay.workspace_scheduling_profiles` (doesn't exist) and a fair-share
  dispatch algorithm layered on top of the capacity coordinator -- Wave 5
  territory per the handoff doc's own "Weighted fair scheduling" section, not
  implementable as a side effect of this review pass.

## Reviewer feedback response, round 2 (2026-08-22)

A second, more detailed review reasserted one round-1 item, flagged several
genuine round-1 regressions, and added new blocking findings across
auth/workspaces, admission/catalog, worker/capacity, and database/runtime. Each
was independently re-verified against live PostgreSQL/Redis before being treated
as real, matching round 1's discipline.

### Fixed, live-verified, and covered by new/updated tests

- **Concurrent first sessions still created duplicate membership rows.** A real
  regression from round 1's own fix: `ensureMembership`'s check-then-insert
  raced under genuine concurrency (5 parallel session-create calls for one new
  user produced 5 `auth.member` rows in the live suite). Fixed with a new
  `("organizationId", "userId")` unique constraint (`0020_member_uniqueness.ts`)
  and rewriting `ensureMembership` to `INSERT ... ON CONFLICT DO NOTHING`
  directly, bypassing the Better Auth adapter (which has no conflict-handling in
  its interface). Verified by reproducing the duplicate rows first, then
  confirming the fix holds across 5 repeated runs.
- **OAuth still did not require a currently verified provider email.** Round 1
  investigated this and found it substantially mitigated by
  `accountLinking.enabled = false` (still true), but the reviewer reasserted it
  directly rather than accepting that mitigation as sufficient. Added an
  explicit, unambiguous gate in the `session.create.before` hook: session
  creation is now rejected outright for any user whose `emailVerified` is false,
  regardless of provider or linking state. Cheap, safe, and removes the
  ambiguity rather than re-arguing the point.
- **Superadmin tables remained directly mutable through broad runtime grants.**
  `relay.system_role_assignments` is the only table in the schema matching this
  description; `relay_app` had unrestricted UPDATE/DELETE on it. Added a trigger
  permitting only a one-time revoke shape (no change to
  `user_id`/`role`/`granted_by`/`granted_at`; a `revoked_at`/`revoked_by`
  transition exactly once) and revoked DELETE from `relay_app` entirely
  (`0023_system_role_assignment_immutability.ts`).
- **Idempotency hashed/scoped too little.** The canonical idempotency hash now
  includes the actor and tool version, not just the input payload -- the same
  idempotency key and payload from a different actor, or against a different
  tool version, is now a conflict rather than a silent replay.
- **A duplicate request racing at a full queue boundary could return
  `queue_full` instead of `replayed`.** `admitToolRun` now takes a
  `pg_advisory_xact_lock` on `(workspaceId, idempotencyKey)` as the first
  statement in its transaction, before the queue-full check runs, serializing
  concurrent requests that share an idempotency key. Verified by firing two
  concurrent identical requests against a queue limit of 1 and asserting the
  outcome set is always `["admitted", "replayed"]`, never `queue_full`.
- **Disabled provider, model, or capacity pool could still admit runs.** The
  binding-resolution query now joins and filters on
  `providers.lifecycle`/`provider_models.lifecycle` (excluding `disabled` and
  `retired`) and `capacity_pools.enabled`.
- **Admission did not persist a routing decision.** Every admitted run now
  writes a `relay.routing_decisions` row (selected binding, provider, provider
  model) alongside its `tool_runs` row.
- **Concurrent `createToolVersion` could throw a raw uniqueness violation.** The
  parent `tools` row is now locked with `SELECT ... FOR UPDATE` as the first
  statement in the transaction, serializing version numbering; the function also
  now returns a typed result (`ok`/`not_found`/`denied`) instead of throwing for
  a missing tool. Verified with two concurrent calls against the same tool,
  asserting sequential versions and no thrown error.
- **Published tool versions could still be deleted; routing policy revisions
  remained mutable.** A `BEFORE DELETE` trigger rejects deleting a
  `tool_versions` row once `published_at` is set; `UPDATE`/`DELETE` were revoked
  from `relay_app` on `relay.routing_policies`
  (`0022_tool_version_delete_and_routing_policy_immutability.ts`).
- **`capacity_pools.provider_model_id` conflicted with the provider-model ID
  type.** Altered to `bigint` with a foreign key to `provider_models`.
- **`execution_jobs.capacity_lease_id` and several tool/counter references
  remained unconstrained.** Foreign keys added for
  `execution_jobs.capacity_lease_id`, `tool_queue_counters.tool_id`, and
  `workspace_tool_queue_counters.tool_id`
  (`0021_capacity_and_counter_foreign_keys.ts`). Verified live that no orphaned
  rows existed before either constraint was added.
- **Nontransactional migrations remained allowed despite the documented
  prohibition.** `validateManifest` now refuses to run any migration with
  `transactional: false` unless it also carries a non-empty
  `nonTransactionalReason`, checked before any DDL runs.
- **Migration commands still required unrelated Redis configuration.**
  `loadRuntimeConfig` split into `loadDatabaseConfig`/`loadBuildInfo`; the
  `migrate` and new `healthcheck` commands in `src/main.ts` now load only what
  they need, no `REDIS_URL` required.
- **Lockfile enforcement was disabled; Docker compile was not frozen; image
  metadata/healthcheck were incomplete.** `deno.json`'s `lock.frozen` is now
  `true`; `Dockerfile`'s `deno compile` now passes `--frozen`; added full OCI
  `LABEL` metadata (title, source, revision, version, licenses, etc.) and a
  `HEALTHCHECK` that execs the compiled binary's own new `healthcheck` command
  (checks database connectivity and migration-ledger drift) rather than
  depending on `curl`/`wget`. Verified with a real `docker build` and
  `docker run` against the live dev Postgres/Redis network: confirmed OCI labels
  via `docker inspect`, confirmed `Health.Status: "healthy"`, confirmed the
  image still runs as non-root.
- **Live validation was not green.** Both reported failures were reproduced and
  fixed at their root cause, not papered over:
  - "110 passed, 1 failed from concurrent personal-workspace membership" is the
    same duplicate-membership regression above, fixed by
    `0020_member_uniqueness.ts`.
  - "108 passed, 3 failed due to auth test cleanup/isolation interacting with
    catalog actors" was a real isolation bug: `packages/auth`'s live tests reset
    shared tables with a blanket `DELETE FROM auth."user"`/`auth.organization`
    at test start, which deleted rows a concurrently-running catalog/queue
    fixture still depended on once all three packages' live suites ran together
    (not the case when `packages/auth` ran alone, which is why round 1 didn't
    catch it). Rewritten across `auth_test.ts`, `authorization_test.ts`, and
    `system-roles_test.ts` to use `unique()`-scoped fixture emails and narrow,
    per-row cleanup instead. Reproduced directly with
    `deno test --parallel packages/auth/ packages/catalog/ packages/queue/`
    before the fix (failures matched the report) and confirmed clean after
    (47/47 passed).

### Investigated, found already true or safely deferred by design

- **Production test-utils separation.** `packages/queue/src/test_support.ts` is
  the only test-fixture module in the repo. It is not exported from
  `@relay/queue`'s package surface (only `./src/index.ts` is), and no production
  entrypoint (`src/main.ts`, `apps/api`, `apps/worker`) imports it or anything
  like it -- only `*_test.ts` files do. No change needed: this separation
  already holds.
- **Proxy/IP trust.** `packages/auth/src/auth.ts`'s rate-limit configuration has
  no `trustedProxies` list set, and no code anywhere parses
  `X-Forwarded-For`/`X-Real-IP` directly. Better Auth's rate limiter degrades to
  one shared bucket per path rather than trusting a spoofable header -- a safe
  default, not a vulnerability, and already documented in-code as pending the
  production Nginx topology. Left as configuration to fill in once that topology
  exists, not a code defect.

### Investigated, confirmed real but not closeable this pass

- **Session freshness / reauthentication for high-risk actions.**
  `docs/implementation-handoff/03-auth-workspaces.md` specifies a 15-minute
  session-freshness window with required reauthentication before high-risk
  actions, but no "high-risk action" route or gate exists yet to attach it to --
  there is nothing to wire a freshness check into. Tracked as unimplemented, not
  mitigated; belongs with whatever feature first introduces a high-risk,
  reauth-gated action rather than as a standalone patch now.
- **Audit redaction is a shallow safety net, not a guarantee.**
  `packages/audit`'s `redactSnapshot` does regex-match six key-name patterns
  (password/secret/token/credential/authorization/cookie/apikey) on
  `before`/`afterSnapshot` fields only, by the code's own comment "a safety net,
  not a substitute for callers building clean snapshots." Sensitive data under a
  differently-named key, embedded in a string value, or in a non-snapshot field
  (`action`, `reasonCode`, etc.) is not caught. This is a real limitation of a
  blocklist approach; closing it properly means moving callers toward
  allowlisted, structured snapshot fields rather than widening the regex, which
  is a design change bigger than this pass.

### Deferred — unchanged from round 1, or newly confirmed to overlap with an existing deferral

- **Workspace creation is still not one atomic organization/member/mapping
  operation.** `ensurePersonalWorkspace` still creates the Better Auth
  organization via `adapter.create` and claims `personal_workspaces`/
  `auth.member` as separate statements, not one transaction --
  `auth.api.createOrganization` was already spiked and rejected (401) from
  inside the session hook, per the existing code comment, so true atomicity
  needs Better Auth's own transactional surface, not something this package can
  add unilaterally. Correctness under concurrency now comes from idempotent
  conflict-handling at every step (`ON CONFLICT DO NOTHING` on both the mapping
  and the membership insert) rather than atomicity: every caller converges on
  the same organization and exactly one membership row, verified live under
  5-way concurrency. The known cost is a harmless orphaned organization row on
  the losing side of a race, already documented as acceptable pending an
  organization-deletion UI.
- **Better Auth organization mutation endpoints remain exposed without complete
  audit coverage.** Unchanged from round 1 -- needs Better Auth's hook surface
  wired per `organization` plugin route, scoped work not started.
- **Scheduling class, cost, and deadlines remain caller assertions.** Overlaps
  with the already-deferred weighted-fair-scheduling and metering gaps: a
  scheduling class or deadline can't be verified against anything until
  `relay.workspace_scheduling_profiles` and a real scheduler exist to interpret
  it. Not separable from those items.
- **Admission still succeeds without a usage reservation; queue counters still
  lack terminal success/failure/cancellation accounting.** Both unchanged from
  round 1 -- usage reservation needs metering (doesn't exist yet); terminal
  counter accounting needs the worker to reach a terminal state to account for,
  which doesn't exist yet either.
- **Worker/capacity: the production worker is still a signal-waiting
  placeholder.** BullMQ consumption, cancellation, retry classification,
  provider execution, terminal transitions, reconciliation, bounded shutdown,
  Redis-loss reconciliation, durable lease rehydration, weighted fair
  scheduling, and full capacity-unit/lease-ownership behavior are all unchanged
  from round 1's assessment -- this remains the largest gap and the intended
  next-wave target.

### On the validation report's remaining items

- **`deno lint`: passes.** Unchanged, still true.
- **Frozen type-check / lockfile wanted modification.** Fixed above --
  `deno.json`'s `lock.frozen` is now `true`.
- **73 CRLF files.** The current checkout has zero CRLF files, in both the
  working tree and every committed blob (`git grep -Ilc $'\r'` across the repo
  returns nothing). Round 1 already added `.gitattributes` (`text=auto eol=lf`)
  to force LF on every fresh checkout. What `.gitattributes` cannot do is
  retroactively rewrite files already sitting on disk in a checkout made before
  that file existed -- Git only applies line-ending normalization on
  checkout/clone or an explicit `git add --renormalize .`, never silently to an
  existing working tree. The reviewer's "in this existing checkout" phrasing
  matches that exactly: this is very likely a pre-existing local checkout, not
  something a further repo-side change can reach. A fresh `git clone` or
  `git add --renormalize . && git commit` in the affected checkout resolves it;
  there is nothing left to fix from the repository side.
- **Non-live run / live validation counts.** Superseded by this round's fixes
  above; see the re-run counts noted in each fix.

## Design readiness

Two historical visual handoffs are tracked as versioned snapshots:

- `design/v1/` is the initial Ledger handoff.
- `design/v2/` is the expanded storage-first package.

The normalized `design/v3/` package, committed at `1eb7a3d`, pivots to Tools,
Runs, Artifacts, metering, provider administration, and managed sharing. The
owner authorized it as the current implementation reference. Current exports,
real provider fixtures, route/tool names, and several production facts remain
explicit exceptions in its manifest. See
[`../design/README.md`](../design/README.md) and
[`implementation-handoff/08-web-v3.md`](implementation-handoff/08-web-v3.md).

V1/v2 lack the current golden path; v3 represents it:

```text
browse tool
  -> inspect contract and meter
  -> configure
  -> estimate
  -> run
  -> observe
  -> inspect output artifacts
  -> create managed share link
```

Shared frontend foundation and unaffected routes may start from v3. Production
copy/contracts that depend on fixture providers, pricing, public route names, or
missing assets remain blocked. Raw canvas/runtime files are provenance rather
than production source.

## Decisions required before implementation workstreams fan out

Resolved by the owner on 2026-08-21 (see below); remaining rows still gate their
listed work.

| Decision                              | Why it gates work                                                                                  | Status                                                                                                                                                                                                                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Approve a current design handoff      | Landing, IA, dashboard routes, artifact UI, and generator flow otherwise encode the wrong product. | Resolved: v3 is the implementation target; v2 stays a component/state reference, matching `design/README.md`. No change to the recorded manifest exceptions.                                                                                                                                                 |
| Select database and migration tooling | Auth, catalog, jobs, artifacts, metering, audit, and changelog all need one migration owner.       | Resolved: PostgreSQL 18 per the VPS remediation doc; `pg` + Kysely + Better Auth's `pg` adapter sharing one pool, as already recorded in `00-research-decisions.md`. Local dev/test infra runs via Docker Compose (Postgres 18, Redis, MinIO), not native installs.                                          |
| Select MCP SDK/protocol version       | Determines the Streamable HTTP contract implemented in Wave 4B.                                    | Resolved: `@modelcontextprotocol/server@2.0.0`, protocol `2026-07-28` — confirmed still current against the npm registry on 2026-08-21.                                                                                                                                                                      |
| Select MCP OAuth/auth mechanism       | Determines how both users and MCP clients authenticate.                                            | Resolved: [ADR 0001](adr/0001-mcp-auth-via-better-auth-mcp-plugin.md) — Better Auth's `@better-auth/mcp` + `jwt()` plugins for both user sessions and MCP client OAuth, superseding the hand-built provider `06-http-mcp-events.md` originally specified.                                                    |
| Complete queue compatibility spike    | Job schema and shutdown semantics depend on what can run reliably in a compiled Deno image.        | Resolved: [ADR 0002](adr/0002-bullmq-redis-client-selection.md) — `bullmq@6.1.2` + `ioredis@5.11.1`, both cleared as a `deno compile` binary against live Redis. Note: npm now publishes BullMQ `6.2.0` and ioredis `6.0.0` (a major bump) past this pinned snapshot — re-verify before ever bumping either. |
| Select first image provider/model     | Defines the first real input, output, error, safety, and usage contract.                           | Open                                                                                                                                                                                                                                                                                                         |
| Approve initial meter policy          | Reservations and run receipts cannot be implemented from provider cost alone.                      | Open                                                                                                                                                                                                                                                                                                         |
| Approve pre-1.0 release policy        | CI/CD tagging and changelog release creation need one source of release truth.                     | Open                                                                                                                                                                                                                                                                                                         |

## Recommended next implementation slice

Do not start with image-provider adapters against the current scaffold. The next
logical sequence is:

1. Fix container and validation foundations — done for the two defects known at
   audit time (Dockerfile continuation, verified with a real `docker
   build`;
   `deno task check` scope; see Known defects and risks). Still add readiness
   dependency checks and fail-fast configuration loading, plus
   `migrate`/`healthcheck` image commands, as part of Wave 1 Lane 1A.
2. Approve the revised design — done: the owner confirmed v3 as the
   implementation target with v2 as a component/state reference (see Decisions
   required, below).
3. Implement PostgreSQL migrations, Better Auth, Google/GitHub login, personal
   workspace creation, the landing page, and one protected `/dashboard` page as
   one tested slice -- backend half done (migrations, Better Auth, OAuth config,
   personal workspaces, superadmin, all verified live); the landing page and
   protected `/dashboard` page are still Wave 4C, blocked on the v3 web
   foundation (Wave 2C).
4. Add changelog, OpenTelemetry, durable audit events, and CI/CD as the next
   tested slice.
5. Begin registry, artifact, job, and metering milestones from
   [`product-and-roadmap.md`](product-and-roadmap.md).

This order matches the agreed delivery plan and creates stable integration
points for independent worktrees.
