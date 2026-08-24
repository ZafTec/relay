# `@relay/observability`

Application-side observability primitives for Relay's Deno-native OpenTelemetry
provider. This package uses only `@opentelemetry/api`; it does not initialize an
SDK, provider, processor, or exporter.

## Runtime contract

Relay sends traces, metrics, and captured console logs to one OTLP/HTTP
endpoint: Grafana Alloy. Alloy owns redaction, filtering, batching, retry, and
routing to Prometheus, Loki, and the selected persistent trace backend.

Set these before the Deno process starts (native OTel initializes before
application code can generate a useful instance ID):

```text
OTEL_DENO=true
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy:4318
OTEL_SERVICE_NAME=relay-api
OTEL_RESOURCE_ATTRIBUTES=service.namespace=relay,deployment.environment.name=production,service.version=<VERSION>,relay.build.revision=<GIT_SHA>,service.instance.id=<NEW_UUID_PER_PROCESS>
OTEL_PROPAGATORS=tracecontext
OTEL_DENO_CONSOLE=capture
OTEL_METRIC_EXPORT_INTERVAL=15000
OTEL_TRACES_SAMPLER=always_on
```

Use `loadObservabilityConfig()` at startup to reject split signal endpoints,
exporter/header overrides, baggage propagation, signal-specific protocols,
credential-bearing endpoints, and malformed resource attributes. A deployment
launcher must generate a fresh `service.instance.id` for every process start;
never put one static UUID in Compose. Pin the Deno runtime because native OTel
behavior and supported environment variables are version-bound.

## Application usage

```ts
import {
  createHonoRouteEnrichment,
  createJsonLogger,
  createRelayTelemetry,
  extractTraceContext,
  injectTraceContext,
} from "@relay/observability";

const telemetry = createRelayTelemetry({
  instrumentationName: "relay-api",
  instrumentationVersion: "1.0.0",
  maxMetricAttributeSets: 256,
  attributes: {
    maxValuesPerKey: 64,
    allowedValues: {
      provider: ["approved-provider"],
      "queue.name": ["execution"],
    },
  },
});
const logger = createJsonLogger();
const routeEnrichment = createHonoRouteEnrichment(telemetry);

await telemetry.withSpan(
  "provider.submit",
  { kind: "client", attributes: { provider: "approved-provider" } },
  async (span) => {
    span.addEvent("provider.accepted", { outcome: "accepted" });
    logger.info({
      eventName: "provider.submit",
      message: "Provider submission accepted",
      operation: "submit",
      outcome: "accepted",
      provider: "approved-provider",
    });
  },
);

const queueMetadata = injectTraceContext();
const parentContext = extractTraceContext(queueMetadata);
await telemetry.withSpan(
  "bullmq.consume",
  {
    kind: "consumer",
    parentContext,
    attributes: { "queue.name": "execution" },
  },
  async () => {
    // Re-read durable work and process one attempt.
  },
);
```

Pass `routeEnrichment` to Hono as middleware. It is structurally typed and does
not import Hono or application code. It uses only `req.method`, `req.routePath`,
`res.status`, and optional `error`. Missing or unsafe route templates become the
bounded `/__unknown__` sentinel; raw request paths are never used. Server 5xx
and framework exceptions set ERROR; status-only failures do not invent exception
events. The HTTP histogram records response-header/handshake duration. SSE
connection lifetime must use `relay.sse.connections` separately.

## Metric contract

Metric names have fixed instrument kinds, UCUM units, descriptions, and
per-metric label allow-lists in `src/telemetry.ts`. Callers cannot change units
or create an approved name with the wrong instrument kind. The principal groups
are:

- Histograms in seconds: HTTP request, job-attempt, capacity-wait, provider, and
  storage operation duration.
- Monotonic counters: outcomes, attempts/retries/stalls/cancellations,
  heartbeats, denials, transferred bytes, and reconnects.
- Observable gauges: queue depth/age, provider cooldown, settlement lag, and
  outbox depth/age.
- Up-down counters: active capacity permits and SSE connections.

Duration histograms also supply explicit second-based bucket advice instead of
Deno's generic custom-histogram defaults. With Prometheus
`UnderscoreEscapingWithSuffixes`, these contracts yield the names used by the
dashboard examples, such as `relay_http_server_request_duration_seconds_bucket`,
`relay_worker_heartbeats_total`, and `relay_queue_oldest_age_seconds`. Units
such as `{job}` are annotations and do not add misleading `_ratio` suffixes.

## Safety properties

- Log output has one fixed JSON schema and no arbitrary metadata bag. Omitted
  optional fields remain `null`; they do not create `other` or `/__unknown__`
  sentinel dimensions.
- An attached error always replaces the supplied message with a generic safe
  message; raw error messages, causes, and stacks are never exported.
- Only approved telemetry attribute keys are retained. Unknown keys such as
  user, workspace, request, run, job, artifact, and session IDs are dropped.
- Controlled values have a hard process-local cardinality ceiling and optional
  exact allow-lists. Overflow maps to `other`; route overflow maps to the valid
  `/__unknown__` route sentinel.
- Each metric accepts only its declared labels and admits at most
  `maxMetricAttributeSets` distinct sanitized label sets per process (256 by
  default). New sets beyond the cap are dropped while existing sets continue.
- Queue propagation validates W3C `traceparent`/`tracestate`, requires a valid
  `traceparent`, and admits no baggage or vendor headers even if another global
  propagator tries to emit them. Extraction always starts from `ROOT_CONTEXT`;
  missing/malformed metadata and propagator failures return `ROOT_CONTEXT`
  rather than inheriting an unrelated ambient span. Consumer spans also default
  to `ROOT_CONTEXT` when no explicit queue parent is supplied; otherwise they
  use the persisted producer context as their parent. Each retry creates another
  consumer span with that same producer parent, making attempts siblings rather
  than nesting retries.
- Span, metric, logger sink, observable callback, and context-manager failures
  are swallowed. Business callbacks execute once and retain their own result or
  error.
- Observable gauges are best effort. Deno does not guarantee collection of their
  final value on exit; use synchronous instruments for events that must be
  exported during normal shutdown.

Alloy remains the mandatory second redaction boundary because Deno's automatic
HTTP instrumentation sees raw URLs before Hono middleware can sanitize them.
Application code must use `JsonLogger` for operational logs and must not pass
errors, payloads, URLs, headers, or arbitrary objects to other `console.*`
calls; Deno captures every console call, including dependency/runtime output.

## Integration not applied in this lane

The following work intentionally remains outside this package-only draft:

1. Add `./packages/observability` to the root `workspace` array and regenerate
   the root lockfile.
2. Generate the per-process UUID and set the native OTel environment before
   starting each API/worker process; call `loadObservabilityConfig()` at
   startup.
3. Create one telemetry/logger instance per service and register
   `createHonoRouteEnrichment()` on the API after routing can expose
   `req.routePath` but before responses leave the middleware chain.
4. Persist `injectTraceContext()` output in queue ticket metadata and use
   `extractTraceContext()` as the parent for every worker attempt.
5. Add the declared spans/metrics/logger calls to API, worker, queue, database,
   storage, provider, metering, SSE, outbox, and shutdown paths. Do not add raw
   identifiers or arbitrary error fields.
6. Verify compiled-process export, bounded shutdown loss, and collector outage
   behavior against the pinned Deno runtime and merged live Alloy pipeline.

No root, app, queue, or other-package integration is included here. No root
`imports` entry is required: this package scopes its only runtime dependency as
`@opentelemetry/api -> npm:@opentelemetry/api@1` in its own `deno.json` (and
scopes `@std/assert` for tests). No SDK, exporter, Hono, or other runtime
dependency is needed.
