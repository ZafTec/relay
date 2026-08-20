# Relay

Relay is a curated tool and artifact registry for AI agents. Agents invoke
versioned tools, observe asynchronous work, and receive durable artifacts
through managed URLs. The initial catalog will focus on metered image
generation.

The repository currently contains the initial Deno/Hono runtime and canonical
product documentation. Authentication, the dashboard, MCP, persistence, jobs,
storage, metering, and provider integrations have not been implemented yet.

## Prerequisites

- Deno 2.9 or newer
- PostgreSQL 18
- Redis
- S3-compatible storage such as MinIO, Cloudflare R2, or AWS S3

PostgreSQL, Redis, object storage, and observability services are expected to be
deployed independently from the application Compose project.

## Local setup

```sh
cp .env.example .env
deno task dev:api
```

The initial API endpoints are:

- `GET /health/live`
- `GET /health/ready`
- `GET /version`
- `GET /api/v1`

Start the placeholder worker in another terminal:

```sh
deno task dev:worker
```

## Validation

```sh
deno task check
deno task compile
```

## Repository structure

```text
apps/api/             Hono HTTP API
apps/worker/          Background worker process
packages/config/      Runtime configuration
packages/contracts/   Shared service contracts
src/main.ts           Compiled API/worker process dispatcher
docs/                 Architecture and decision documentation
```

See [`docs/product-and-roadmap.md`](docs/product-and-roadmap.md) for the
canonical product and architecture direction,
[`docs/implementation-status.md`](docs/implementation-status.md) for verified
repository progress, and [`docs/versioning.md`](docs/versioning.md) for the
release-versioning proposal that still requires approval.
