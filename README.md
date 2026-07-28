# Relay

Relay is a multi-tenant storage and image-generation service exposed through a
dashboard, HTTP API, and remote MCP server.

The repository currently contains the initial Deno/Hono runtime and architecture
documentation. Product features and provider integrations have not been
implemented yet.

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

See [`docs/architecture.md`](docs/architecture.md) for the agreed system design
and [`docs/versioning.md`](docs/versioning.md) for the versioning proposal that
still requires discussion.
