# Relay observability deployment templates

> **Template status — not production-ready.** The live Alloy configuration,
> installed Alloy image/digest and stability level, Tempo deployment/storage,
> Prometheus startup flags, Grafana exports, datasource UIDs, Docker network
> names, and alert ownership were not supplied. Export and reconcile those live
> inputs before enabling any file in this directory. Do not replace the current
> Alloy file blindly; it already appears to collect PostgreSQL metrics.

These files describe the intended path only:

```text
relay-api / relay-worker
  -> private Alloy OTLP/HTTP :4318
  -> memory limit -> fail-closed redaction -> relay-only filter -> per-signal batch
  -> Prometheus native OTLP (metrics)
  -> Loki native OTLP (logs)
  -> Tempo OTLP/HTTP (traces, preferred)
```

Jaeger is represented only by a disconnected smoke-test exporter example. The
supplied Jaeger is memory-backed and must never be the production trace store or
receive a permanent duplicate trace stream.

## Mandatory reconciliation before production

1. Export `/opt/prometheus/alloy-config.river` and merge the Relay components;
   do not overwrite unrelated scrape pipelines.
2. Pin the exact Alloy image/digest. Run that image's formatter and validator
   with the deployed `--stability.level`; component syntax is version-bound.
3. Confirm the final URLs from Alloy exporter telemetry and backend logs:
   - Prometheus: `http://prometheus:9090/api/v1/otlp/v1/metrics`
   - Loki: `http://loki:3100/otlp/v1/logs`
   - Tempo: `http://tempo:4318/v1/traces`
4. Audit the live Tempo version, private receiver, durable object storage,
   WAL/live-store persistence, retention, compaction, and limits. Prove a trace
   survives a Tempo restart before production approval.
5. Put Relay and Alloy ingest on the exact collector-ingest network. Publish no
   Alloy ingest port to the host. Bind Alloy administration port `12345` only to
   loopback/management or protect it through a separate management gateway.
6. Load-test the memory limiter, batches, and three independent in-memory
   exporter queues under the actual container limit. `block_on_overflow=false`
   intentionally drops telemetry instead of backpressuring Relay. Persistent
   queues require an explicit preview-component decision and are not enabled.
7. Ensure Relay console logs reach Loki only through Deno OTLP capture. Do not
   also scrape Relay Docker stdout. Emit one unique canary and prove exactly one
   Loki record.
8. Configure Prometheus's native OTLP receiver, out-of-order window, and
   `UnderscoreEscapingWithSuffixes`. Promote only `deployment.environment.name`
   and `service.version` for these examples. Prometheus maps
   `service.namespace/service.name` to `job` (for example, `relay/relay-api`),
   `deployment.environment.name` to `deployment_environment_name`, and
   `service.instance.id` to `instance`; the dashboards use that mapping. Give
   the `relay-public` probe the same bounded environment label. Do not also
   remote-write the same Relay metrics.
9. Configure Loki OTLP labels so only `service.name`, `service.namespace`, and
   `deployment.environment.name` are index labels. Instance/version/revision,
   trace/span IDs, and application IDs remain structured metadata.
10. Export existing Grafana datasources, dashboards, alerts, contact points, and
    notification policies. Reconcile the stable UIDs in these examples and
    restore-test an isolated Grafana clone before mounting provisioning.
11. Decide whether Grafana-managed alerting or Alertmanager owns routing,
    silencing, grouping, and inhibition. Set `RELAY_ENVIRONMENT` to the exact
    promoted environment value before provisioning. The included rules are
    paused and have no contact points or credentials.
12. Reconcile translated Prometheus metric/label names against the pinned
    Prometheus version and OTLP translation strategy before trusting dashboards
    or alerts.

## Files

- `alloy/relay-otlp.river.example`: Alloy v1.18.1-syntax merge fragment with
  fail-closed JSON-body parsing, field allow-listing, defense-in-depth
  deletion/redaction, and independent signal queues.
- `alloy/jaeger-smoke.river.example`: disconnected, time-boxed smoke exporter.
- `grafana/provisioning/**/*.example`: provisioning skeletons. Rename only after
  live export/review.
- `grafana/dashboards/relay/*.json`: version-controlled dashboard skeletons with
  stable UIDs and explicit reconciliation notes.

No file contains credentials. Every file is an example or dashboard skeleton;
none is a complete Compose stack or ready-to-apply production configuration.
Internal service URLs are topology placeholders, not proof that the live Docker
networks, aliases, ports, authentication policy, or backend APIs match. The
observed broad `proxy-net` is not the target design: create and verify the
purpose-specific collector-ingest and observability-backend networks first.

## Validation contract

The standalone Alloy examples are syntax-checked against
`grafana/alloy:v1.18.1`. Re-run the same checks on the reconciled file with the
exact deployed digest, stability level, and actual in-container paths:

```text
grafana/alloy:v1.18.1 fmt --test <merged Alloy file>
grafana/alloy:v1.18.1 validate --stability.level=<live-level> <merged Alloy file>
promtool check config <live prometheus.yml>
promtool check rules <reconciled rule files>
docker compose --project-name <live-project> config --quiet
```

Then send bounded `telemetrygen` traces, metrics, and logs through the private
receiver; verify one signal in each backend, exporter/refusal/queue metrics,
log-to-trace linking, outage/drop behavior, sensitive-canary absence, and one
real test notification. Static validation alone does not prove connectivity.
