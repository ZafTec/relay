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

Start the worker in another terminal:

```sh
deno task dev:worker
```

## Initial superadmin bootstrap

The first system superadmin is granted by a one-shot operator command, never by
email matching or an HTTP endpoint. The target user must sign in once so an
immutable Better Auth user ID exists.

Run the command with these values injected by the deployment secret mechanism:

```text
DATABASE_URL                         dedicated relay_migrator login
RELAY_BOOTSTRAP_USER_ID              immutable Better Auth user ID
RELAY_BOOTSTRAP_IDEMPOTENCY_KEY      16-128 governance-safe characters
```

Do not place migrator credentials in the API or worker environment, and do not
put bootstrap values on the command line where task output, shell history, or
process inspection can expose them.

```sh
deno task admin:bootstrap-superadmin
```

The command refuses runtime database credentials, scopes `relay_owner` to one
transaction, and records the grant and audit event atomically. Keep and reuse
the exact idempotency key until the command reports success; a matching replay
is safe. After the first grant, later superadmin changes use the authenticated,
fresh-session administration boundary.

## Validation

```sh
deno task check
deno task compile
(cd apps/web && npm ci && npx --no-install playwright install chromium)
(cd apps/web && npm run check && npm run build && npm run test:e2e)
```

Run the disposable PostgreSQL, Redis, MinIO, backend-image, and web-image gate
without production credentials:

```sh
deno task check:containers
```

The container gate publishes no host ports and removes its isolated volumes on
exit. Diagnostic logs are written to the ignored `.ci-artifacts/` directory.

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
