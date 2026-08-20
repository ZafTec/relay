# Relay architecture

Status: supporting index\
Canonical architecture: [`product-and-roadmap.md`](product-and-roadmap.md)

Relay's product model changed from a storage-first service to a curated tool and
artifact registry for AI agents. The previous detailed contents of this file are
superseded because they mixed durable technical decisions with obsolete product
scope, route naming, and delivery priorities.

Use [`product-and-roadmap.md`](product-and-roadmap.md) for:

- Product purpose, actors, and canonical domain glossary
- Tool and tool-version registry lifecycle
- Immediate and queued execution rules
- Run, job, attempt, cancellation, and retry semantics
- Artifact versions, output sets, managed URLs, and share links
- Image-provider and model abstraction
- Metering, reservations, entitlements, and provider costs
- HTTP, MCP, OAuth, workspace, and security contracts
- OpenTelemetry, deployment, milestones, and future capabilities

Use [`implementation-status.md`](implementation-status.md) to distinguish that
target from code that is actually present.

## Stable technical decisions

The following high-level choices remain active:

| Concern           | Decision                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------- |
| Product           | Curated tool and artifact registry for AI agents                                          |
| Runtime           | Deno 2 compiled for production                                                            |
| HTTP              | Hono                                                                                      |
| Web               | React and Vite after design approval                                                      |
| Processes         | One source and image, dispatched as `relay api` or `relay worker`                         |
| Database          | PostgreSQL 18 as durable source of truth                                                  |
| Coordination      | Redis for queue transport, leases, rate limits, cache, and SSE fan-out                    |
| Storage           | Deployment-configured S3-compatible adapter supporting MinIO, R2, AWS S3, and equivalents |
| Auth              | Better Auth with Google and GitHub                                                        |
| MCP authorization | Better Auth OAuth 2.1 Provider; not the deprecated MCP plugin                             |
| MCP transport     | Official MCP SDK with Streamable HTTP                                                     |
| Live dashboard    | SSE plus durable HTTP resynchronization                                                   |
| Telemetry         | OpenTelemetry collector to Prometheus, Jaeger, and Loki                                   |
| Deployment        | Stateless Compose application containers; infrastructure is managed independently         |

## Current repository shape

```text
apps/api/             Hono API scaffold
apps/worker/          Deno worker-process scaffold
packages/config/      Minimal runtime configuration
packages/contracts/   Minimal shared contracts
src/main.ts           API/worker process dispatcher
docs/                 Product and engineering decisions
design/relay/         Tracked but product-stale visual handoff
```

Expected additions are described by milestone in the canonical document. The web
application path is `apps/web`, not `apps/dashboard`.

## Related decisions

- [`brand.md`](brand.md)
- [`changelog.md`](changelog.md)
- [`legal.md`](legal.md)
- [`versioning.md`](versioning.md)
