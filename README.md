# Relay

Relay is a curated tool and artifact registry for AI agents. Agents invoke
versioned tools, observe asynchronous work, and receive durable artifacts
through managed URLs. The MVP catalog includes GPT Image 2, FLUX.2 Pro, and
Mistral OCR on Azure.

The Deno/Hono API and worker, React dashboard, OAuth authentication, MCP,
PostgreSQL usage ledger, Redis scheduling, and MinIO artifacts are implemented.
Release and deployment templates are available; the first production release
and deployment still require operator verification.

## Prerequisites

- Deno 2.9.4 (the CI version)
- Node.js 24.19.0 for the web application
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

Basic API endpoints include:

- `GET /health/live`
- `GET /health/ready`
- `GET /version`
- `GET /api/v1`

Start the worker in another terminal:

```sh
deno task dev:worker
```

Run `npm ci` and `npm run dev` in `apps/web` for the web application. Configure
the role-specific environment entries described in `.env.example` before
starting the API and worker. Provision PostgreSQL, Redis and a versioned MinIO
bucket first; `compose.dev.yaml` provides local service templates. Run
`deno task migrate:up` with the dedicated migrator database URL before starting
runtime processes with the restricted `relay_app` credentials.

Signing in creates a personal workspace but grants no execution allowance.
Execution requires an explicit `tools.execute` capability and a usage grant
for `images.generated` or `ocr.requests`. See the
[allowance policy](docs/implementation-handoff/05-domain-storage-metering.md#explicit-mvp-allowances)
before enabling a workspace.

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

`deno task check` enforces at least 55% backend line, branch, and function
coverage. `npm run check` enforces at least 60% web statement, branch, function,
and line coverage. Both commands write ignored LCOV reports under their local
`coverage/` directories.

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
apps/web/             React product and administration UI
packages/config/      Runtime configuration
packages/contracts/   Shared service contracts
src/main.ts           Compiled API/worker process dispatcher
docs/                 Architecture and decision documentation
```

See [`docs/product-and-roadmap.md`](docs/product-and-roadmap.md) for the
canonical product and architecture direction,
[`docs/implementation-status.md`](docs/implementation-status.md) for verified
repository progress, and [`docs/versioning.md`](docs/versioning.md) for the
approved release-versioning policy.
