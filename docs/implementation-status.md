# Relay implementation status

Status: repository audit\
Verified: 2026-08-20\
Baseline revision: `f4e423b` (`main` before this documentation update)

## Summary

Relay is currently a small, healthy Deno/Hono process scaffold plus extensive
planning and design material. It is not yet an authenticated storage service,
tool registry, MCP server, job system, or image-generation platform.

The implemented code proves four narrow things:

- The workspace resolves and type-checks.
- One executable can dispatch an API process or worker process.
- The Hono API serves basic health, version, and root API routes.
- The placeholder worker starts and waits for shutdown.

The current container cannot build because of a Dockerfile syntax error. The
repository-wide check also fails because it formats design-source files that are
not maintained in Deno's canonical format. Targeted source checks and all three
existing API tests pass.

## Status vocabulary

| State       | Meaning                                                                     |
| ----------- | --------------------------------------------------------------------------- |
| Implemented | Working source exists and was validated for its current narrow contract.    |
| Scaffolded  | A process, type, route, or boundary exists but lacks production behavior.   |
| Documented  | The target behavior is described but no meaningful implementation exists.   |
| Missing     | No implementation was found.                                                |
| Blocked     | Work should not begin until an explicit dependency or decision is resolved. |

## Capability matrix

| Area                           | State       | Repository evidence                                                                | Gap to target                                                                                        |
| ------------------------------ | ----------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Deno workspace                 | Implemented | `deno.json`, workspace package manifests                                           | Add web app and future domain packages without losing compiled-runtime checks.                       |
| Process dispatcher             | Implemented | `src/main.ts` dispatches `relay api` and `relay worker`                            | Add migration and operational one-shot commands when needed.                                         |
| HTTP server                    | Implemented | `apps/api/src/server.ts` starts Hono with `Deno.serve`                             | Add middleware, graceful shutdown, proxy policy, security headers, and production routing.           |
| API shell                      | Scaffolded  | `apps/api/src/app.ts` exposes four basic routes and JSON errors                    | No domain endpoints, auth, request IDs, rate limits, or contract validation.                         |
| Liveness                       | Implemented | `GET /health/live` returns service and build data                                  | Current behavior is adequate only as process liveness.                                               |
| Readiness                      | Scaffolded  | `GET /health/ready` always returns `ok` with an empty check list                   | Must verify PostgreSQL, Redis, storage, migrations, and critical configuration.                      |
| Build information              | Scaffolded  | `/version`; `APP_VERSION` and `GIT_SHA` in `packages/config/src/index.ts`          | No CI injection, build timestamp, OCI labels, MCP metadata, or telemetry resource fields.            |
| Runtime configuration          | Scaffolded  | Port validation and basic build fields in `packages/config/src/index.ts`           | Database, Redis, storage, auth, OAuth, provider, and telemetry settings are not loaded or validated. |
| Worker process                 | Scaffolded  | `apps/worker/src/worker.ts` logs startup, waits for a signal, and logs shutdown    | No queue, leases, jobs, heartbeats, attempts, handlers, retries, or cancellation.                    |
| Shared contracts               | Scaffolded  | `packages/contracts/src/index.ts` defines six job statuses plus health/build types | No IDs, schemas, errors, tool, run, artifact, usage, or event contracts.                             |
| Structured logging             | Scaffolded  | API and worker write a few JSON console records                                    | No common logger, request/trace context, redaction, levels, sinks, or schema tests.                  |
| PostgreSQL                     | Missing     | No driver, pool, migrations, schema, repositories, or database package             | Required for every durable domain and Better Auth.                                                   |
| Redis                          | Missing     | No client or adapter                                                               | Required for queue transport, coordination, rate limits, and SSE fan-out.                            |
| Queue                          | Missing     | No implementation or compatibility spike                                           | Select a Deno-compatible adapter and prove compile, retry, cancellation, and shutdown.               |
| Tool registry                  | Missing     | No tool or tool-version domain code                                                | Implement code-first handlers and database-controlled publication metadata.                          |
| Provider/model catalog         | Missing     | No provider registry or adapter                                                    | Select providers after contract and cost-model review.                                               |
| Tool runs                      | Missing     | Only a `JobStatus` type exists                                                     | Add durable runs, jobs, attempts, progress, idempotency, and outbox.                                 |
| Retry safety                   | Documented  | Target rules are in `product-and-roadmap.md`                                       | No submission-certainty or reconciliation implementation.                                            |
| S3-compatible storage          | Missing     | No SDK, adapter, bucket checks, object-key policy, or MinIO tests                  | Implement deployment-configured storage behind domain interfaces.                                    |
| Artifacts and versions         | Missing     | No schema or services                                                              | Add durable artifacts, immutable versions, provenance, output sets, retention, and purge.            |
| Managed URLs and share links   | Missing     | No resolver, token model, or route                                                 | Keep durable Relay links separate from short-lived S3 signatures.                                    |
| Image generation               | Missing     | No provider SDK or handler                                                         | Build one provider end-to-end, then add adapters through the same contract suite.                    |
| Metering                       | Missing     | No estimate, reservation, usage, cost, or settlement code                          | Required before production provider execution.                                                       |
| Entitlements and subscriptions | Documented  | Architecture planning exists                                                       | Build capability/limit checks independently from future billing provider.                            |
| Better Auth                    | Missing     | No package, schema, adapter, or route                                              | Implement PostgreSQL-backed auth and personal workspaces.                                            |
| Google OAuth                   | Missing     | Configuration is not used by runtime                                               | Add provider config, callback tests, trusted origins, and production base URL.                       |
| GitHub OAuth                   | Missing     | Configuration is not used by runtime                                               | Add email-scope handling and callback tests.                                                         |
| Workspace tenancy              | Missing     | No organizations, membership, roles, or query scoping                              | Use owner/admin/member and keep superadmin separate.                                                 |
| MCP server                     | Missing     | No MCP SDK, `/mcp`, discovery routes, or tools                                     | Use official SDK and Better Auth OAuth Provider, not the deprecated MCP plugin.                      |
| Dashboard and landing          | Blocked     | No `apps/web` exists                                                               | Wait for a revised, owner-approved design aligned with the tool/artifact registry.                   |
| SSE live updates               | Missing     | No event route or fan-out                                                          | Implement durable fetch plus workspace-scoped SSE reconnect/resync.                                  |
| OpenTelemetry                  | Missing     | No SDK initialization or exporter configuration                                    | Add API/worker resources, trace propagation, metrics, and redaction.                                 |
| Audit log                      | Missing     | No durable audit model or service                                                  | Required for admin, keys, roles, share links, tools, entitlements, and changelog.                    |
| Changelog                      | Documented  | `docs/changelog.md` contains workflow and schema                                   | No database, routes, public pages, admin pages, or superadmin checks.                                |
| Legal acceptance               | Documented  | `docs/legal.md`                                                                    | No legal-document or acceptance records.                                                             |
| CI                             | Missing     | No `.github/workflows` files                                                       | Add PR quality, integration, container, and security jobs.                                           |
| CD                             | Missing     | No Docker Hub workflow                                                             | Add immutable-SHA publication on merge and release-tag publication.                                  |
| Compose app definition         | Scaffolded  | `compose.yaml` defines API and worker using external configuration                 | No migration service, dependency health checks, immutable image pin, or production override.         |
| Container image                | Broken      | `Dockerfile:14-15` omits a continuation before `src/main.ts`                       | Docker parses `src/main.ts` as an instruction; no image can currently be built.                      |
| Product release tags           | Missing     | No Git tags were present in the prior audit                                        | Approve SemVer policy before official release automation.                                            |

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

Commands run on 2026-08-20:

```sh
deno fmt --check apps packages src
deno lint apps packages src
deno check src/main.ts
deno test --allow-env apps/api/src/app_test.ts
```

Result: passed. Deno checked 11 source files, linted 7 files, and ran 3 tests
with 3 passed and 0 failed.

Repository-wide command:

```sh
deno task check
```

Result: failed in `deno fmt --check`. The command includes design documents,
SVGs, and the untracked newer design-system bundle. It reported 50 unformatted
files out of 89 before lint, type check, or tests could run. This is a
task-scope problem, not evidence that application source failed formatting.

Container command:

```sh
docker build --progress=plain -t relay:audit .
```

Result: failed before build execution:

```text
Dockerfile:15
unknown instruction: src/main.ts
```

The multiline `RUN deno compile` command lacks a trailing continuation after
`--output /out/relay`.

## Known defects and risks

### P0 — Container build is broken

`Dockerfile:14` needs a line continuation or the source path on the same
command. Until fixed, local Compose builds and Docker Hub CD cannot succeed.

### P1 — Readiness can produce a false positive

`/health/ready` reports healthy without checking dependencies. An orchestrator
could route traffic to an instance that cannot reach PostgreSQL, Redis, or
storage.

### P1 — Configuration presents more capability than runtime supports

The example environment file documents future integrations, while the runtime
loader currently reads only application name, port, version, and revision. A
misconfigured production process will not fail fast for missing durable services
because those services are not wired at all.

### P1 — No durability exists behind the worker contract

The worker's shutdown behavior is only a signal wait. There is no queue lease,
checkpoint, heartbeat, or recovery behavior to make long-running work safe.

### P2 — Repository quality command includes generated design material

`deno task check` should target maintained application source and separately
validate design artifacts with the appropriate tools. Running `deno fmt` over
exported SVG/design files would create large unrelated diffs.

### P2 — Test confidence is intentionally narrow

The three tests cover liveness, version output, and 404 shape only. There are no
configuration edge tests, readiness tests, process smoke tests, worker tests,
container tests, or dependency integration tests.

## Design readiness

Two visual handoffs exist:

- `design/relay/` is tracked and therefore the current Git authority.
- `design/Relay design handoff checklist/design/relay/` is a larger untracked
  package with more screens and source canvases.

Neither represents the clarified tool-and-artifact-registry product. The newer
handoff is more complete for the previous storage-first direction and is useful
for tokens, identity, shell, auth, jobs, status, notices, drawers, tables, and
changelog patterns. It lacks the current golden path:

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

Frontend implementation remains blocked until the design agent reconciles that
flow and the owner approves one canonical tracked handoff. See the design-agent
backlog in the newer design folder.

## Decisions required before implementation workstreams fan out

| Decision                              | Why it gates work                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Approve a current design handoff      | Landing, IA, dashboard routes, artifact UI, and generator flow otherwise encode the wrong product. |
| Select database and migration tooling | Auth, catalog, jobs, artifacts, metering, audit, and changelog all need one migration owner.       |
| Complete queue compatibility spike    | Job schema and shutdown semantics depend on what can run reliably in a compiled Deno image.        |
| Select first image provider/model     | Defines the first real input, output, error, safety, and usage contract.                           |
| Approve initial meter policy          | Reservations and run receipts cannot be implemented from provider cost alone.                      |
| Approve pre-1.0 release policy        | CI/CD tagging and changelog release creation need one source of release truth.                     |

## Recommended next implementation slice

Do not start with image-provider adapters against the current scaffold. The next
logical sequence is:

1. Fix container and validation foundations.
2. Approve the revised design.
3. Implement PostgreSQL migrations, Better Auth, Google/GitHub login, personal
   workspace creation, the landing page, and one protected `/dashboard` page as
   one tested slice.
4. Add changelog, OpenTelemetry, durable audit events, and CI/CD as the next
   tested slice.
5. Begin registry, artifact, job, and metering milestones from
   [`product-and-roadmap.md`](product-and-roadmap.md).

This order matches the agreed delivery plan and creates stable integration
points for independent worktrees.
