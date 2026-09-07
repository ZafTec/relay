# Observability and durable audit

Phase: Wave 1D foundation, expanded in Waves 2B–6\
Primary owner: observability/audit worktree\
Depends on: stable process/config contracts\
Must not block application availability when telemetry is unavailable

## Objective

Instrument API, worker, queue, database, storage, provider, metering, and
release behavior with correlated traces, metrics, and sanitized logs, while
keeping security/governance audit events as durable PostgreSQL records.

## Selected topology

```mermaid
flowchart LR
    API[Relay API] -->|OTLP HTTP| Alloy[Grafana Alloy]
    Worker[Relay worker] -->|OTLP HTTP| Alloy
    Alloy -->|OTLP metrics| Prometheus
    Alloy -->|OTLP logs| Loki
    Alloy -->|OTLP traces| Tempo[Tempo preferred]
    Alloy -. smoke only .-> Jaeger[In-memory Jaeger]
    Prometheus --> Grafana
    Loki --> Grafana
    Tempo --> Grafana
```

Relay sends all application signals only to Alloy. Alloy handles filtering,
batching, retry, and backend routing. Do not configure three independent
application exporters.

## Deno native OpenTelemetry

Use Deno's built-in provider:

```text
OTEL_DENO=true
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_SERVICE_NAME=relay-api or relay-worker
OTEL_RESOURCE_ATTRIBUTES=service.namespace=relay,deployment.environment.name=development,service.version=<version>,relay.build.revision=<sha>,service.instance.id=<id>
OTEL_PROPAGATORS=tracecontext
OTEL_DENO_CONSOLE=capture
OTEL_METRIC_EXPORT_INTERVAL=15000
```

Import only:

```text
npm:@opentelemetry/api@1
```

Do not initialize `NodeSDK`, a second provider, or application-side exporters.
Deno automatically instruments `Deno.serve`, `fetch`, runtime metrics, and
console logs. Pin the Deno version because native OTel behavior is
version-bound. Generate a unique `service.instance.id` for every process start;
do not reuse a static Compose service value.

### Required application enrichment

Deno's auto server span lacks Hono route templates. Middleware must:

- Set `http.route` to the matched template
- Rename span to `METHOD /templated/path`
- Set normalized ERROR status and sanitized exception event
- Never use raw IDs or tokens in span names
- Record route-level custom metrics because native HTTP metrics lack route
- Treat SSE auto span as handshake only; record connection lifetime separately

Deno automatically records `url.full`, `url.query`, and `url.path` on incoming
and outgoing HTTP spans. Alloy transforms must delete `url.query`, delete or
reconstruct `url.full` without query data, and remove or policy-normalize
`url.path`. Keep templated `http.route` for inbound analysis and allow-list only
safe outbound paths. This is mandatory for OAuth callback codes/state, route
IDs, object keys, and presigned S3 credentials; application middleware alone
cannot reliably sanitize every automatic child `fetch` span.

Manual spans cover PostgreSQL, Redis, BullMQ, S3, provider submission/retrieval,
authorization, reservation, settlement, outbox, and reconciliation.

## Trace propagation through BullMQ

Use the global OTel API to inject W3C trace context when creating a ticket and
extract it in the worker. Allow only `traceparent` and `tracestate`; omit
baggage because queue metadata persists in Redis.

At Nginx or another boundary before Deno creates its automatic server span,
strip or restart untrusted external trace context unless an explicit
trusted-caller policy allows it. Otherwise a caller can choose trace identity or
influence parent-based sampling.

If `bullmq-otel` is used, wrap its Telemetry interface. Do not export raw BullMQ
attributes that may include job IDs, options, results, progress, failure
reasons, worker IDs, or serialized payloads.

Allowed bounded attributes include:

```text
queue.name
job.handler
job.state
attempt.number
operation
outcome
error.type
provider
model
```

Set failed worker spans to ERROR explicitly. Document whether consumer spans use
the producer as parent or link; remain consistent across retries.

## Trace model

```text
HTTP or MCP request
  -> authenticate/authorize
  -> entitlement and estimate
  -> reservation transaction
  -> outbox publication
  -> BullMQ producer
  -> worker claim/attempt
  -> capacity permit
  -> provider submit/inspect/retrieve
  -> object storage
  -> artifact transaction
  -> usage settlement
  -> SSE/outbox event
```

A run may span minutes. Do not assume tail sampling can wait long enough for
late worker failure. Use deterministic parent-based head sampling after initial
acceptance testing.

Initial low-volume acceptance:

```text
OTEL_TRACES_SAMPLER=always_on
```

Later:

```text
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=<approved ratio>
```

Metrics and operational errors are not reduced by trace sampling; they retain
independent batching, exporter, overflow, shutdown, and redaction loss
semantics.

## Metrics

Initial Relay instruments:

```text
relay.http.server.request.duration
relay.auth.outcomes
relay.queue.depth
relay.queue.oldest_age
relay.queue.admission_rejections
relay.queue.deferrals
relay.job.attempt.duration
relay.job.attempts
relay.job.retries
relay.job.stalls
relay.job.cancellations
relay.worker.heartbeats
relay.capacity.active
relay.capacity.wait.duration
relay.capacity.rate_denials
relay.provider.operation.duration
relay.provider.outcomes
relay.provider.cooldown
relay.storage.operation.duration
relay.storage.bytes
relay.artifact.outcomes
relay.usage.reservation.outcomes
relay.usage.settlement.lag
relay.sse.connections
relay.sse.reconnects
relay.outbox.pending
relay.outbox.oldest_age
```

Allowed labels are bounded enums or catalog values with controlled cardinality:
route template, method, status class, operation, outcome, fixed queue/handler,
tool key/version, allow-listed provider/model, scheduling class, and normalized
error type.

Never use user/workspace/request/run/job/artifact/session IDs, URLs, object
keys, prompts, or arbitrary error messages as metric labels.

OTLP push does not create Prometheus's scrape `up` for Relay. Add external HTTP
probing plus explicit worker heartbeat and backend health metrics.

## Logs

Use a shared application logger that emits a fixed JSON schema to console. Deno
`OTEL_DENO_CONSOLE=capture` preserves stdout and exports correlated OTel logs.

Do not also scrape the same container stdout into Loki, or logs will be
duplicated. Keep Docker JSON log rotation for break-glass local inspection.

Schema examples:

```text
event.name
severity
message
operation
outcome
error.type
http.route
tool.key
tool.version
provider
model
attempt.number
queue.reason
```

High-cardinality IDs may be structured metadata only where policy permits and
must never become Loki index labels.

Redact before logging and again in Alloy:

- Authorization, API keys, cookies, OAuth codes/state/tokens
- Query strings and raw full URLs
- Signed URLs and object keys
- Prompts, file contents, provider payloads/results
- SQL parameters/query values
- BullMQ options/results/progress/failure strings
- Arbitrary request/response bodies

Raw `error.message` and `error.stack` are unsafe by default. Normalize error
type, use a safe message, and include protected stack information only under an
explicit operator policy.

## Alloy pipeline

Conceptual order:

```text
otelcol.receiver.otlp
  -> memory_limiter
  -> transform/redaction
  -> filter
  -> batch
  -> separate metrics/logs/traces exporters
```

Requirements:

- Listen on the container interface required by Alloy, publish no host port, and
  enforce privacy through an exact collector-ingest Docker network membership.
- Bind Alloy's `12345` administration endpoint to loopback/management interface,
  front it with a protected sidecar, or use a separate gateway instance. Docker
  network membership alone cannot hide one port of a multi-homed container.
- Enable OTLP HTTP 4318; optional private gRPC 4317 for telemetrygen tests.
- Use bounded request size, memory limiter, queue, and retry.
- Apply mandatory span/log transforms that remove URL query/full values,
  normalize or remove `url.path`, drop sensitive headers, and remove unapproved
  exception messages/stacks before batching.
- Keep backend queues independent so one outage does not block other signals.
- Prefer dropping telemetry over applying backpressure to Relay.
- Scrape Alloy's own metrics and alert on refusal/export/queue saturation.
- Do not use debug exporter in production.
- Persistent OTel queues require a currently preview Alloy component; decide
  explicitly whether preview is acceptable.

Collector routing and backend configuration are maintained outside this repository.
Use a local collector when testing telemetry export.

## Durable audit events

Audit is not a log stream. Store in PostgreSQL:

```text
relay.audit_events
  id
  occurred_at
  actor_type
  actor_user_id nullable
  oauth_client_id nullable
  workspace_id nullable
  action
  target_type
  target_id nullable
  outcome
  reason_code nullable
  before_snapshot jsonb nullable
  after_snapshot jsonb nullable
  request_id nullable
  trace_id nullable
  ip_hash_or_policy_value nullable
  user_agent_summary nullable
```

Audit actions include:

- Auth session/account link/revoke
- Workspace/member/role changes
- System-superadmin grants
- Tool publish/disable/deprecate/retire
- Provider routing/credential-state changes
- Share-link creation/revocation
- Artifact deletion/purge/restore
- Entitlement/scheduling/meter policy changes
- Changelog publish/unpublish
- Billing/subscription changes later

For fail-closed governed changes, insert the audit event in the same PostgreSQL
transaction as the change. Give retryable actions a unique event/idempotency
key. Use an insert-only application path or security-definer function; normal
runtime roles cannot directly update/delete audit rows. Corrections append new
events. Define partitioning, retention, reader permissions, bounded snapshot
size, PII policy, and backup/restore coverage. PostgreSQL access control is not
cryptographic tamper evidence; add hash-chained/signed exports only if that
stronger requirement is approved.

## Duplicate-signal prevention

Inventory the live Alloy and Prometheus graph before adding Relay:

- Send each Relay metric through exactly one path: OTLP or remote write.
- Select one canonical HTTP duration metric for SLO dashboards when both Deno
  native and Relay route-level histograms exist.
- Emit a unique log canary and prove exactly one Loki record; do not combine
  Deno console OTLP with Docker-log scraping for Relay.
- Fan traces to Jaeger only during a bounded smoke window, then remove that
  path.
- Verify infrastructure scrape targets are not also forwarded into Prometheus by
  another Alloy pipeline.

Receiver flags alone do not duplicate data; duplicate exporter/scrape paths do.
Alert on rejected/out-of-order Prometheus samples and Alloy queue drops.

## Dashboards

Provision or document:

1. Relay overview: availability, rate, errors, latency, readiness, release.
2. Execution: depth, oldest age, throughput, attempts, failures, stalls,
   cancellations, capacity, worker heartbeat.
3. Provider/storage: latency, rate limits, cooldown, cost units, S3 outcomes.
4. Usage: reservation denials, settlement lag, reconciliation.
5. Telemetry pipeline: Alloy accepted/refused/exported, queue saturation,
   backend errors.
6. Backend health: Prometheus TSDB, Loki ingestion/query, selected persistent
   trace-backend storage/query, container resources.
7. Release comparison by bounded service version.

Keep dashboard and alert configuration outside this application repository.
Do not overwrite existing Grafana alerts without exporting/reviewing them first.

## Alerts

Initial categories; thresholds are selected from observed baselines/SLOs:

- External API unavailable
- Required readiness dependency failure
- Fast/slow error-budget burn
- Route latency breach
- Worker heartbeat missing
- Queue depth/oldest age breach
- Job failure/retry/stall/cancellation spike
- Provider error/rate-limit/cooldown spike
- PostgreSQL/Redis/S3 errors
- Usage settlement/outbox reconciliation lag
- Alloy refused/dropped/export failures or queue saturation
- Loki discarded samples
- Selected persistent trace-backend ingestion/storage/query/compaction failures
- Prometheus/Loki/trace-backend disk or memory pressure
- Unexpected absence of application telemetry
- Notification delivery failure

Prometheus rule evaluation alone is not notification routing. Confirm whether
Grafana-managed alerting or Alertmanager owns routing, silencing, grouping, and
inhibition.

## Expected tests

### Application

- API request creates a templated route span.
- Sanitized log inside request shares trace ID.
- PostgreSQL/Redis/S3/provider spans nest correctly.
- Enqueue and worker consume share intended trace relationship.
- Retry/deferral/cancellation remain distinguishable.
- Telemetry outage does not fail request/job.
- Graceful shutdown exports completed signals within bounded time.

### Redaction/cardinality

Inject canaries representing bearer token, OAuth code/state, signed URL, prompt,
object key, and SQL value. Assert none appears in Loki or the selected
persistent trace backend.

Inspect Prometheus series and Loki index labels for prohibited IDs or unbounded
values. Fail tests for raw path IDs when a route template is expected.

### Pipeline

- `telemetrygen` traces/metrics/logs traverse Alloy to each backend.
- Alloy restart/backend outage behavior matches documented loss tolerance.
- Loki log-to-trace derived field works.
- A trace survives restart of the selected persistent trace backend.
- Alert rules pass static/rule tests and send one test notification.
- Dashboard queries load against representative fixtures.

### Audit

- Required actions create exactly one durable event.
- Normal app role cannot update/delete audit history.
- Secret fields are absent from snapshots.
- Audit write failure follows the action's defined fail-open/fail-closed policy.
- Trace/request correlation is present without becoming an index label.

## Completion gate

Observability is complete when API-to-worker-to-provider traces correlate,
metrics remain bounded, sensitive-data canaries are absent, telemetry outages do
not impact product availability, durable audit is immutable, and at least one
real alert notification plus trace-retention restart test has succeeded.
