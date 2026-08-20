# Runtime and database implementation

Phase: Waves 0–1\
Primary owner: platform/database worktree\
Blocks: auth, queue, storage, domain services, release deployment

## Objective

Create a reproducible compiled backend with typed configuration, one managed
PostgreSQL pool per process, reviewed checksummed migrations, accurate health,
and explicit operational commands.

This phase fixes foundation defects but does not add product UI or provider
code.

## Proposed paths

```text
packages/config/
packages/database/
  src/pool.ts
  src/database.ts
  src/migrations/
  src/migrator.ts
  src/health.ts
  src/testing/
packages/contracts/
src/main.ts
Dockerfile
compose.yaml
compose.test.yaml
scripts/
```

One lane owns `deno.json`, `deno.lock`, `src/main.ts`, and the migration
manifest. Other agents request changes rather than editing them concurrently.

## Parallel work inside this phase

After the config and database interfaces are agreed:

| Lane                | Owns                                                      | Can run with                                  |
| ------------------- | --------------------------------------------------------- | --------------------------------------------- |
| Runtime commands    | Dispatcher, shutdown, build metadata, healthcheck command | Database role/bootstrap documentation         |
| Database core       | Pool, Kysely, migration runner, database health           | Runtime container repair                      |
| Test infrastructure | Disposable PostgreSQL/Redis/MinIO Compose and helpers     | Database implementation                       |
| Backend container   | Compile and runtime stages, non-root execution            | Migration unit tests                          |
| CI source checks    | Source-scoped format/lint/type/test commands              | All other lanes after command names stabilize |

Merge config/contracts first, database second, runtime/container third, test/CI
last.

## Configuration contract

Configuration is parsed once at process startup and passed explicitly. Missing
or invalid production values fail before the service reports readiness.

Categories:

```text
Application
  APP_ENV
  APP_VERSION
  GIT_SHA
  BUILD_TIMESTAMP
  PORT
  LOG_LEVEL
  PUBLIC_ORIGIN

Database
  DATABASE_URL
  DATABASE_POOL_MAX
  DATABASE_CONNECT_TIMEOUT_MS
  DATABASE_STATEMENT_TIMEOUT_MS

Redis
  REDIS_URL
  REDIS_PREFIX
  REDIS_CONNECT_TIMEOUT_MS

Storage
  S3_ENDPOINT
  S3_PUBLIC_ENDPOINT
  S3_REGION
  S3_BUCKET
  S3_ACCESS_KEY_ID
  S3_SECRET_ACCESS_KEY
  S3_FORCE_PATH_STYLE

Authentication
  BETTER_AUTH_URL
  BETTER_AUTH_SECRET
  GOOGLE_CLIENT_ID
  GOOGLE_CLIENT_SECRET
  GITHUB_CLIENT_ID
  GITHUB_CLIENT_SECRET
  AUTH_TRUSTED_ORIGINS

Telemetry
  OTEL_DENO
  OTEL_EXPORTER_OTLP_PROTOCOL
  OTEL_EXPORTER_OTLP_ENDPOINT
  OTEL_SERVICE_NAME
  OTEL_RESOURCE_ATTRIBUTES
  OTEL_TRACES_SAMPLER
  OTEL_TRACES_SAMPLER_ARG
```

Rules:

- Never log raw configuration values.
- Error messages name missing variable names, not secret contents.
- Production rejects placeholder auth/provider secrets.
- URL configuration is parsed as `URL` and validated by scheme and host policy.
- Durations and byte limits are bounded integers with explicit units.
- Boolean parsing accepts a documented finite set only.
- The app version is embedded by CI; a runtime variable may not impersonate a
  different binary version.

## Database stack

Recommended versions at the research snapshot:

```text
pg 8.23.0
@types/pg 8.23.1
kysely 0.29.5
```

The implementation spike may select newer versions, but it records and pins the
exact tested set.

Use one `pg.Pool` per process. Kysely and Better Auth share that process pool
unless the auth schema requires a deliberately separate connection/search path.
Pool ownership belongs to process bootstrap; feature packages never call
`pool.end()`.

Set a stable application name per process:

```text
relay-api
relay-worker
relay-migrate
```

Pool sizing considers every API/worker replica and leaves PostgreSQL capacity
for migrations, administration, backups, and observability.

Do not convert PostgreSQL `numeric` or `bigint` implicitly. Repository methods
return explicit domain types or strings where exact values matter.

## Schemas and roles

Recommended logical schemas:

```text
auth     Better Auth-owned tables
relay    Relay domain and governance tables
```

Keeping Better Auth's default model names inside an `auth` schema avoids
renaming plugin concepts while separating ownership.

Production roles:

```text
relay_owner      NOLOGIN; owns schemas and objects
relay_migrator   LOGIN NOINHERIT; may SET ROLE relay_owner
relay_app        LOGIN; runtime DML only
```

Requirements:

- Revoke untrusted `CREATE` on `public`.
- Set existing grants and owner default privileges.
- API/worker credentials cannot create, alter, truncate, or drop objects.
- API/worker cannot assume `relay_owner`.
- Migrator credentials are available only to the one-shot migration command.
- Application `superadmin` is unrelated to PostgreSQL role administration.

For local/CI environments, use disposable equivalents. Do not weaken production
role tests merely because CI uses containers.

## Migration format

Use an immutable, statically imported manifest:

```ts
interface Migration {
  id: string;
  checksumSha256: string;
  transactional: boolean;
  up(db: Kysely<unknown>): Promise<void>;
}
```

Ledger:

```text
relay.schema_migrations
  id text primary key
  checksum_sha256 char(64) not null
  applied_at timestamptz not null
  duration_ms bigint not null
  app_version text not null
  app_revision text not null
```

Rules:

1. Acquire one session-level PostgreSQL advisory lock on a pinned connection.
2. Apply each migration in its own transaction by default.
3. Insert its ledger row in that same transaction.
4. Refuse a changed checksum, missing historical migration, duplicate ID, or
   reordered manifest.
5. Release the lock in `finally`; connection loss also releases it.
6. Apply lock and statement timeouts.
7. Initially prohibit non-transactional migrations. Add an explicit reviewed
   mode only when an operation such as `CREATE INDEX CONCURRENTLY` requires it.
8. Never execute migrations from normal API/worker startup.
9. Use expand-and-contract changes so the previous image remains deployable.

Checksum committed canonical migration content, not JavaScript function source
serialization.

## Better Auth schema integration

Generate SQL from the complete pinned auth configuration, review it, and include
it in Relay's normal migration history.

Preferred workflow:

```text
pinned auth CLI generate
  -> temporary generated SQL
  -> review/diff
  -> committed Relay migration
  -> Relay migrator applies it
```

Do not run Better Auth's direct schema migration against production as an
unreviewed startup action.

CI should regenerate or ask Better Auth for its migration plan against a fully
migrated disposable database and fail on unexpected drift.

## Process commands

The backend executable should eventually support:

```text
relay api
relay worker
relay migrate up
relay migrate status
relay healthcheck live
relay healthcheck ready
```

Unknown commands exit with usage status. Operational commands produce structured
output and nonzero failure codes without leaking secrets.

## Graceful shutdown

A common shutdown coordinator should:

1. Receive `SIGTERM`/`SIGINT`.
2. Mark readiness false.
3. Stop new HTTP accepts, scheduler claims, or queue claims.
4. Allow bounded completion/checkpointing.
5. Close BullMQ objects and Redis clients.
6. Close the PostgreSQL pool.
7. Allow telemetry export a bounded final interval.
8. Exit before Compose's grace period.

Windows development receives only supported signals; production behavior is
validated in the Linux image.

## Health semantics

### Liveness

Proves only that the process event loop and HTTP handler respond. It must not
query every dependency.

### Readiness

Checks without mutation:

- Configuration parsed
- Expected migration range is compatible
- PostgreSQL reachable
- Redis reachable for API/worker functions that require it
- Storage reachable when the process needs storage
- Worker queue initialized for worker readiness
- Required startup policy/catalog state loaded

Telemetry backends do not control readiness. An Alloy/Loki/Tempo outage must not
make Relay unavailable.

Return `503` when a required check fails, with bounded check names and no
connection strings.

## Backend image

Fix the current missing continuation in `Dockerfile`, then implement:

- Pinned Deno builder image/digest
- Frozen lockfile
- Explicit target architecture
- Compiled executable including required npm resources
- Non-root runtime
- Read-only compatible filesystem
- CA certificates
- No Deno, Node, npm, source tree, OAuth secrets, or build credentials in the
  runtime image
- OCI version/revision/source/created labels
- A healthcheck command that does not require shell tools

The backend image serves API, worker, and migration commands. The web image is
separate and covered later.

## Expected tests

### Unit

- All configuration parsers accept valid boundary values and reject malformed,
  empty, unsafe, or out-of-range values.
- Secret values never appear in error serialization.
- Build metadata cannot be overridden inconsistently at runtime.

### Database integration

- Fresh PostgreSQL 18 applies all migrations.
- Re-running migrations is a no-op.
- Two concurrent migrators result in one application and one waiter/no-op.
- A changed historical checksum fails before DDL.
- A deliberately failing migration rolls back its DDL and ledger row.
- Killing the lock holder permits later recovery.
- Runtime role CRUD succeeds and DDL/role escalation fails with permission
  error.
- Readiness distinguishes unreachable, behind, ahead/incompatible, and healthy
  schemas.

### Container

- Compiled source-free backend starts `api`, `worker`, and `migrate` commands.
- No Node/Deno executable or external source tree is required at runtime.
- Process runs as non-root.
- `SIGTERM` completes within configured grace.
- Live/ready healthcheck command returns correct exit codes.
- Image scan has no unreviewed critical/high fixable findings.

Equivalent tests are acceptable when they prove the same failure modes.

## Completion gate

This phase is complete only when later lanes can rely on:

- One typed config source
- One database connection/pool contract
- One immutable migration history
- Reproducible backend compilation
- Accurate readiness
- Bounded graceful shutdown
- Source-scoped quality commands that exclude raw design exports intentionally
