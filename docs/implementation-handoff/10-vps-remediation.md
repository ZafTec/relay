# VPS infrastructure remediation and integration

Status: recommendations based on the owner's redacted configuration excerpts\
Scope: `/opt/prometheus`, `/opt/jaeger`, `/opt/loki`, `/opt/grafana`,
`/opt/postgresql`, `/opt/redis`, `/opt/nginx`, and future `/opt/relay`

Do not copy secrets from live files into this repository. Templates use variable
names and `[REDACTED]` placeholders only.

## Priority summary

| Priority | Fix                                                                                           |
| -------- | --------------------------------------------------------------------------------------------- |
| P0       | Authenticate the Redis healthcheck; current `redis-cli ping` conflicts with `requirepass`     |
| P0       | Configure Redis `noeviction` and increase/measure memory before BullMQ production use         |
| P0       | Choose persistent Tempo or persistent Jaeger; current in-memory Jaeger loses traces           |
| P0       | Obtain and validate the live Alloy config before sending Relay telemetry                      |
| P1       | Remove, loopback-bind, or private-interface-bind PostgreSQL/Redis host ports                  |
| P1       | Create dedicated Relay database and least-privilege runtime/migrator roles                    |
| P1       | Pin all infrastructure images instead of `latest`/broad floating tags                         |
| P1       | Add Relay/Nginx routes for MCP, OAuth metadata, SSE, and share resolution                     |
| P1       | Stop using `docker compose down -v` for Relay deployments                                     |
| P1       | Decide Grafana-managed alerting versus Alertmanager and export existing alerts before changes |
| P2       | Version-control Grafana datasource/dashboard/rule provisioning                                |
| P2       | Validate resource limits are actually enforced by the installed Compose implementation        |

## Network topology

Observed networks:

```text
proxy-net
postgresql-db-n8n
```

Observed membership:

- Nginx: `proxy-net`
- Redis: `proxy-net`
- Prometheus/Loki/Jaeger/Grafana: `proxy-net`
- Alloy: `proxy-net`, `postgresql-db-n8n`
- PostgreSQL: `postgresql-db-n8n`

Future Relay membership:

| Service         | Networks                                                                   |
| --------------- | -------------------------------------------------------------------------- |
| `relay-web`     | proxy/edge only                                                            |
| `relay-api`     | proxy/edge, PostgreSQL, Redis, MinIO, telemetry as required                |
| `relay-worker`  | PostgreSQL, Redis, MinIO, telemetry; edge only if Redis/Alloy remain there |
| `relay-migrate` | PostgreSQL only                                                            |

A broad shared `proxy-net` lets unrelated containers reach Prometheus, Loki,
Redis, Alloy administration, and other services that have little or no
application-layer authorization. Introduce purpose-specific external networks
before production: an edge network for Nginx/web/API, a Relay backplane for API/
worker/Redis/Alloy ingest, a database network, a storage network, and an
observability-backend network. Nginx/web must not reach PostgreSQL, Redis, Loki,
Prometheus, Tempo, or Alloy administration. Until then, do not publish Relay
service ports to the host.

Record exact external network names in `/opt/relay/current-release.env` and
validate them before deployment.

## Redis

### Current issues

- Password appears in `redis-server --requirepass ...` command configuration and
  may be visible through process/container inspection.
- Healthcheck does not authenticate.
- Image is floating `redis:alpine`.
- Container memory is limited to 128 MB.
- `maxmemory-policy noeviction` is not explicit.
- AOF is enabled, but `appendfsync` and recovery behavior are not documented.
- Host port `6379` is published.
- Redis and RedisInsight share a broadly connected proxy network.

### Required target

- Pin a tested Redis version/digest compatible with selected BullMQ.
- Use a mounted Redis configuration and ACL/secret mechanism rather than a
  literal password in command arguments.
- Set `appendonly yes` and normally `appendfsync everysec`.
- Set `maxmemory-policy noeviction`.
- Size memory from BullMQ backlog, delayed/scheduler state, rate windows, AOF
  rewrite headroom, and RedisInsight overhead. Do not ship with 128 MB merely
  because it starts.
- Monitor `used_memory`, fragmentation, evictions, rejected connections, blocked
  clients, latency, AOF errors/rewrite, and restarts.
- Remove host port or bind only to loopback/WireGuard when remote administration
  is required.
- Protect RedisInsight behind strong authentication and private access.

Use a dedicated health ACL user with only `PING`. Load its credential from a
mounted secret and expose it to `redis-cli` through `REDISCLI_AUTH`, not `-a`,
so the secret is not placed in argv. The exact shell depends on the chosen
secret mount; it must match exactly `PONG`, and an invalid credential must make
the healthcheck fail. Do not commit either the Relay or health credential.

If Redis is shared, give Relay a separate ACL user and restricted key/channel
patterns. Deny dangerous administrative commands. Prefer a dedicated Relay Redis
instance; changing a shared instance to `noeviction` can turn memory pressure
into write failures for every existing application.

### BullMQ checks

Read-only version/policy/health inspection may run on live Redis. Restart, loss,
script-cache, AOF restore, and failure injection run only on a
production-matching isolated staging or dedicated test Redis—not the shared live
instance.

- Version is supported.
- `CONFIG GET maxmemory-policy` returns `noeviction`.
- Lua/EVALSHA/SCRIPT commands and Streams/blocking commands are permitted by the
  Relay ACL.
- `CONFIG GET` and other administrative validation use a separate operator
  credential, not the restricted Relay user.
- AOF directory/mount, rewrite headroom/status, restart recovery, external
  backup, and restore are proven. `appendfsync everysec` may lose approximately
  one second, so PostgreSQL reconciliation remains mandatory.
- Restart/failure tests recover accepted PostgreSQL jobs.
- Script-cache loss/reload is tested in disposable or dedicated maintenance
  Redis. Do not run `SCRIPT FLUSH` against the shared live instance.

## PostgreSQL

### Current issues

- General `admin` role and `mydb` are unsuitable as Relay runtime identity.
- Host port `5432` is published.
- Backups are mounted but backup/PITR scheduling and restore evidence were not
  provided.
- 512 MB may be adequate for a small MVP but must be measured with existing
  workloads and connection pools.

### PostgreSQL 18 volume safety

Before recreating or changing the PostgreSQL service, inspect the running mounts
and execute `SHOW data_directory`. PostgreSQL 18 container images changed their
default data layout; the supplied `PGDATA=/var/lib/postgresql/18/docker` and
host mount must be verified against the exact image/digest and effective
container mount. Do not "fix" paths before a tested backup/restore. Use
PostgreSQL 18 `pg_dump`/`pg_restore` for the PostgreSQL 18 restore rehearsal; do
not assume a newer-major client will produce output guaranteed to restore into
18.

### Required target

Create:

```text
relay database
relay_owner NOLOGIN
relay_migrator LOGIN
relay_app LOGIN
```

Apply the role/grant model from
[`02-runtime-database.md`](02-runtime-database.md).

If direct host access is retained, prefer WireGuard/private binding or loopback
with SSH tunneling. Firewall allowlisting is useful defense but should not be
the only control.

Validate:

- PostgreSQL listens only on intended interfaces.
- `pg_hba.conf` limits role/database/source combinations.
- TLS and certificate verification when traffic crosses an untrusted boundary.
- Connection headroom across all existing applications.
- WAL/PITR or equivalent backup strategy.
- Restore rehearsal and alert on backup/archive age/failure.
- Disk space and WAL growth.

## Grafana Alloy

The live `alloy-config.river` was not supplied. Do not replace it blindly
because it already appears to scrape PostgreSQL metrics.

Required additions after exporting/reviewing the live file:

```text
private OTLP receiver on 4318, optional 4317
memory limiter
redaction/transform
filter
batch
independent metrics/logs/traces exporters
export queues and bounded retry
Alloy self-metrics scrape
```

Final wire destinations:

```text
metrics -> http://prometheus:9090/api/v1/otlp/v1/metrics
logs    -> http://loki:3100/otlp/v1/logs
traces  -> http://tempo:4318/v1/traces
```

For Alloy's generic `otelcol.exporter.otlphttp.client.endpoint`, configure base
URLs (`.../api/v1/otlp`, `.../otlp`, and `http://tempo:4318`) because the
exporter appends signal paths. Alternatively configure explicit full signal
endpoints. Validate actual outbound URLs from Alloy telemetry rather than
relying only on component health.

Jaeger may temporarily receive traces for smoke tests, but do not permanently
fan every trace to both backends.

The Alloy admin endpoint `12345` must bind to loopback/a management interface,
be fronted by a protected sidecar, or live in a separate gateway/management
instance. Docker network membership alone cannot hide one port on a multi-homed
container. The OTLP receiver may listen on `0.0.0.0` inside its container, has
no host publication, and is reachable only through the collector-ingest network.
Health alone does not prove exporters work; alert on refused data, failed sends,
queue size/capacity, and backend reachability.

The current 256 MB Alloy limit may be too small after adding three OTel
pipelines. Set `memory_limiter` below the actual container cap and load-test
before selecting a final limit.

## Prometheus

Current strengths:

- Persistent data volume
- 14-day retention
- Node exporter and cAdvisor
- OTLP receiver already enabled

Required review/fixes:

- Pin Prometheus image/digest.
- Keep OTLP/remote-write ingestion private.
- Choose one Relay metrics path; do not duplicate OTLP and remote write.
- If using Alloy OTLP export, add:

```yaml
storage:
  tsdb:
    out_of_order_time_window: 30m

otlp:
  translation_strategy: UnderscoreEscapingWithSuffixes
  promote_resource_attributes:
    - deployment.environment.name
    - service.version
```

- Confirm actual Prometheus version supports selected config.
- Add scrape targets for Alloy and telemetry backends.
- Add external probe or blackbox monitoring for public Relay availability.
- Add recording/alert rules and rule tests.
- Define retention size in addition to time if disk protection is needed.
- Monitor TSDB disk, WAL, compaction, head series, churn, ingestion rejection,
  query failures, and rule evaluation.

`service.name`, namespace, and instance map to Prometheus target identity; avoid
promoting every resource attribute.

## Loki

Current strengths:

- TSDB schema v13
- Structured metadata enabled
- Persistent filesystem
- Retention and compactor configured

Required review/fixes:

- Pin Loki image/digest.
- Keep API private; `auth_enabled: false` provides no authorization.
- Confirm schema cutover date matches real history before changing it.
- Use a minimal OTLP label policy. Prefer:

```yaml
limits_config:
  allow_structured_metadata: true
  otlp_config:
    resource_attributes:
      ignore_defaults: true
      attributes_config:
        - action: index_label
          attributes:
            - service.name
            - service.namespace
            - deployment.environment.name
```

- Keep instance ID, version, revision, trace IDs, and application IDs as
  structured metadata rather than index labels.
- Configure Grafana derived fields from normalized `trace_id` to the selected
  persistent trace datasource.
- Alert on `loki_discarded_samples_total`, discarded bytes, ingestion errors,
  query latency/errors, compaction, disk, and retention failures.
- Review max line and structured metadata limits for sanitized stack traces.

Do not ingest both Deno OTLP console logs and Docker stdout through a second
Loki pipeline.

## Tempo versus Jaeger

### Current Jaeger

The supplied all-in-one configuration uses in-memory storage. All traces are
lost on restart. This is not a production retention backend.

Keep it only for:

- Local/temporary smoke tests
- Comparing OTLP output during Tempo setup

Pin the image and determine whether it is Jaeger 1.x or 2.x before using health
endpoints or configuration examples.

### Tempo

`/opt/tempo` exists but no config was supplied. Preferred direction for Grafana:

- Audit installed version and deployment mode.
- For a small VPS, monolithic Tempo may be acceptable but is not HA.
- Configure private OTLP receiver.
- Use durable object storage and persistent WAL/live-store paths.
- Set retention, compaction, ingestion/trace-size/attribute limits, and query
  limits.
- Provision Grafana datasource and test trace persistence across restart.
- Monitor disk/object storage, rejected spans, WAL, compaction, and query
  errors.

No production trace decision is complete until the live Tempo config passes this
audit. If Tempo is rejected, configure a persistent Jaeger storage backend
rather than keeping in-memory storage.

## Grafana

Current Compose mounts only `/var/lib/grafana`; datasource/dashboard/alert
provisioning was not supplied.

Before changing anything:

1. Export existing data sources, dashboards, alert rules, contact points, and
   notification policies.
2. Record stable datasource UIDs.
3. Decide Grafana-managed alerting versus Alertmanager.
4. Identify Grafana's database backend and back it up consistently; do not copy
   a live SQLite file blindly.
5. Back up plugins, effective configuration, and the encryption/secret-key
   material required to decrypt datasource credentials.
6. Restore an isolated Grafana 12.3.1 clone before applying provisioning.

Recommended provisioned resources:

```text
Prometheus datasource
Loki datasource
selected persistent trace datasource
log-to-trace derived field
Relay overview dashboard
Relay execution/capacity dashboard
Relay provider/storage/usage dashboard
telemetry-pipeline dashboard
backend-health dashboard
versioned alert rules and contact policies
```

Do not overwrite manually created alerts without review. Test one real
notification route end to end.

## Nginx

### Client IP trust

The current map accepts `CF-Connecting-IP` whenever the header is present. This
is safe only when direct origin access is blocked to verified Cloudflare source
ranges or the real-IP module trusts only those proxies.

Implement and verify one of:

- Firewall allows only Cloudflare to public 80/443, with explicit trusted
  ranges.
- Nginx `set_real_ip_from` for Cloudflare networks and `real_ip_header`.
- Ignore `CF-Connecting-IP` for direct/private operator traffic.

Do not let arbitrary direct clients choose the key used for rate limiting.

### Relay virtual host

Route order uses exact/prefix Nginx locations:

```text
= /.well-known/oauth-protected-resource/mcp   API
= approved authorization/OIDC metadata aliases API
= /mcp and explicitly chosen /mcp/ behavior  API, streaming settings
= /api/v1/events                              API, SSE settings
^~ /api/                                      API
^~ /s/ or approved ^~ /share/                 API
= /health/live and = /version                  API or explicit rejection
/                                             web
```

Do not route all `/.well-known/` traffic to Relay; ACME remains owned by the
existing Let’s Encrypt configuration. Pin one MCP protocol version and proxy all
methods/headers required by it.

Preserve OAuth callback query strings and `Set-Cookie`/`Location`. Pass
controlled Host/scheme/client-IP headers. Clear untrusted `traceparent`,
`tracestate`, and `baggage` before proxying to Deno unless a trusted propagation
policy applies. Choose and test one mandatory upstream refresh strategy: dynamic
Docker DNS supported by the pinned Nginx image, or `nginx -t` plus graceful
reload after Relay replacement. Use unique network aliases. Sanitize OAuth
callback access logs to avoid query-bearing code/state values.

Nginx request limits protect the edge. Relay application limits still enforce
identity, workspace, tool, provider, and queue policies.

The global 50 MB body limit does not define artifact upload size because normal
uploads go directly to S3. Apply smaller route-specific JSON limits for
auth/API/MCP.

## Infrastructure image policy

Replace floating, broad, or otherwise mutable image references such as:

```text
prom/prometheus:latest
grafana/alloy:latest
jaegertracing/jaeger:latest
grafana/loki:latest
redis:alpine
redis/redisinsight:latest
postgres:18-alpine
grafana/grafana:12.3.1
nginx:alpine
plus the current Tempo, MinIO, node-exporter, and cAdvisor images
```

with tested readable versions plus required production digests. This includes
PostgreSQL, Grafana 12.3.1, Nginx, Tempo, MinIO, node-exporter, and cAdvisor
even when their current tags are not literally `latest`. Upgrade one component
at a time with rollback and config validation. Pin Grafana plugins by
version/checksum or build them into the image; copying an unversioned plugin
directory is not reproducible.

Verify whether `deploy.resources` limits are honored by the installed Docker
Compose version using `docker inspect`; do not assume the Compose model applied
them.

## Relay `/opt` deployment

```text
/opt/relay/
  docker-compose.yml
  .env
  current-release.env
  releases/
  runbooks/
```

Permissions:

- `.env` readable only by the deployment account/root.
- No secret in release environment files, Git, image labels, or Compose command
  arguments.
- Image references use SemVer/digest.

Deployment uses pull, one-shot migration, and `up -d --wait --remove-orphans`.
Do not use `down -v`.

## Host validation checklist

Run on the VPS with redacted output:

```sh
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
docker network ls
ss -lntup
```

The following is a command contract, not yet a runnable script because the live
image versions, entrypoints, and paths were not supplied. The implementation
agent replaces every placeholder with an exact `docker compose exec -T` or
`docker run --entrypoint` command and records its output.

Validate rendered configs with the exact pinned service images and real in-
container paths:

```text
docker compose --project-name <project> config --quiet
<alloy image> fmt --test < config file, or version-supported equivalent
<alloy image> validate --stability.level=<runtime-level> /etc/alloy/<file>
<prometheus image> promtool check config /etc/prometheus/prometheus.yml
<prometheus image> promtool check rules <actual rule files>
<prometheus image> promtool test rules <version-controlled test files>
<loki image> -config.file=/etc/loki/config.yml <version-supported verify flag>
<tempo image> <version-specific config verification>
<nginx image/container> nginx -t
```

Record `docker compose version`; `up --wait` behavior and supported flags are
version-dependent. Static validation does not prove exporter/backend
connectivity.

Private-network health and OTLP smoke tests are specified in
[`11-test-matrix.md`](11-test-matrix.md).

## Required live inputs

Before deployable patches are authored, provide redacted copies/exports of:

- `/opt/prometheus/alloy-config.river`
- `/opt/tempo/docker-compose.yml` and Tempo config
- Prometheus startup flags/runtime info and rule files
- Grafana datasource/dashboard/alert/contact provisioning or exports
- MinIO Compose/network/bucket/CORS configuration
- Intended Relay Nginx virtual host
- Exact Docker network names
- VPS CPU, memory, disk, and backup/PITR status

Documentation can proceed without them; production approval cannot.
