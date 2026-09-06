# Relay on the existing telemetry stack

Reuse Alloy, Prometheus, Loki and Tempo on `proxy-net`. Relay adds no telemetry
containers, networks or published receiver ports.

```text
Relay API / worker → Alloy :4318 → Prometheus / Loki / Tempo
Relay browser → https://zaftech.co/collect → existing Faro receiver
```

## Grafana files for manual import

Upload [`grafana/relay-dashboard.json`](grafana/relay-dashboard.json) using
Grafana's dashboard import screen. It asks for your existing Prometheus, Loki,
and Tempo datasources. Follow [`grafana/IMPORT.md`](grafana/IMPORT.md), then
copy the alert expressions from [`grafana/ALERTS.md`](grafana/ALERTS.md) into
Grafana. No remote Grafana provisioning is needed.

## Existing Alloy configuration

Merge [`alloy/relay-otlp.river.example`](alloy/relay-otlp.river.example) into
`/opt/prometheus/alloy-config.river`, preserving its PostgreSQL scrapes, Docker
logs and Faro receiver. Validate the merged file using the **installed Alloy
binary** before reloading it. Its Relay components accept private OTLP/HTTP on
4318, sanitize telemetry and separate the three signal exporters:

| Signal  | Existing destination                            |
| ------- | ----------------------------------------------- |
| Metrics | `http://prometheus:9090/api/v1/otlp/v1/metrics` |
| Logs    | `http://loki:3100/otlp/v1/logs`                 |
| Traces  | `http://tempo:4318/v1/traces`                   |

Exclude only the `relay` project's `api` and `worker` Docker stdout from the
existing Docker log pipeline. Deno console capture sends their structured logs
through OTLP; scraping stdout as well duplicates them and bypasses collector
sanitation. Keep every other application's pipeline intact.

The shared Alloy container was using about 188 MiB of its 256 MiB limit before
Relay. Give it measured headroom for the added pipeline and use bounded queues;
do not launch another collector. Validate syntax with
`docker exec alloy
/bin/alloy validate ...` using a temporary candidate file,
then remove that file. An exporter outage may drop telemetry when queues fill;
it must not block Relay.

Prometheus already enables its native OTLP receiver. Use
`UnderscoreEscapingWithSuffixes` translation; `service.namespace/service.name`
becomes `job`, e.g. `relay/relay-api`. A 10-minute out-of-order window
accommodates batched arrivals. Promoting `deployment.environment.name` and
`service.version` also supports the older detailed dashboard templates. Loki
already supports native OTLP; Tempo already has durable storage. Preserve those
configurations.

## Frontend collector

Relay sends Faro to the existing `https://zaftech.co/collect` proxy location,
which forwards to Alloy's Faro receiver. Permit the exact
`https://relay.zaftech.co` browser Origin in that receiver and allow collector
POST/OPTIONS through Cloudflare. Keep the existing site origins as well.

Only the production Relay origin enables the SDK. It reports page load, web
vitals and sanitized browser errors. It excludes user/session identifiers, query
strings, dynamic route IDs, DOM selectors, raw exception messages, console logs
and request bodies. Asset filenames and line/column numbers remain for debugging
the matching release. Frontend tracing is not enabled.

## Verify after deployment

Check API request metrics and worker heartbeats in Prometheus, one sanitized
backend log in Loki, and a Relay trace in Tempo. Load the site in a browser and
confirm the collector accepts the POST and `relay-web` appears in Loki. Verify a
log appears only once. Existing infrastructure alerts should cover collector
errors/queue saturation and telemetry backend availability.

The older `grafana/provisioning/` and `grafana/dashboards/relay/` files remain
examples for a separate provisioning workflow. Do not apply them to the shared
Grafana instance for this deployment. Static validation alone does not prove
that live signals have reached the backends.
