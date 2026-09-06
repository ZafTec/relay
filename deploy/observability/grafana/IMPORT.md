# Import the Relay dashboard

In Grafana, open **Dashboards → New → Import**, upload
[`relay-dashboard.json`](relay-dashboard.json), and select your existing
**Prometheus**, **Loki**, and **Tempo** datasources when prompted. Choose a
folder and click **Import**. No datasource UID is hardcoded and no server
provisioning is required.

The dashboard covers API traffic/errors/latency, worker heartbeats, queues,
provider calls, storage, usage settlement, outbox events, backend logs, browser
signals, and traces. Metrics use Prometheus's default OTLP underscore/suffix
translation and `job="relay/relay-api"` / `job="relay/relay-worker"`.

After deployment, check worker heartbeats first, then load the Relay site and
check API traffic and browser signals. Provider and job panels can be empty
before work runs. Do not trigger paid provider calls just to fill a dashboard.
No data on the heartbeat panel needs investigation; it does not mean healthy.

Browser telemetry uses `https://zaftech.co/collect` only on the production Relay
origin. It sends a page-load event, web vitals, and sanitized browser errors.
Local previews do not report. Existing Faro receiver labels vary, so the browser
log panel filters the log body for `relay-web`. The collector must accept the
`https://relay.zaftech.co` Origin, and Cloudflare must allow the collector POST
and CORS preflight without an interactive challenge.

The older `dashboards/relay/` files are detailed provisioning templates. This
single import file is the intended dashboard for the existing shared stack.

# Create alerts manually

Follow [`ALERTS.md`](ALERTS.md). Dashboard imports do not create alert rules;
Grafana alerting does not support the dashboard's datasource prompts.
