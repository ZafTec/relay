# Relay alerts to copy into Grafana

These are starting thresholds for the first deployment. Confirm the live metrics
exist before enabling notifications. Use your existing contact point; no
receiver, datasource, or server-side provisioning is created here.

For each rule, open **Alerting → Alert rules → New alert rule**:

1. Choose your existing **Prometheus** datasource for query **A**, switch to
   **Code**, paste the expression below, and use an **Instant** query.
2. Add a **Threshold** expression **B**: `A IS ABOVE 0`. Make **B** the alert
   condition. The expressions below already perform their own comparison.
3. Evaluate every **1 minute**, use the pending period below, and label the rule
   `service=relay` plus the specified `severity`.
4. Set **No data → Normal** for these expressions. The separate worker-silence
   rule detects missing telemetry. Set query/execution errors to **Error**, and
   route Grafana's `DatasourceError` alerts to your existing contact point.
5. Preview the query and select the contact point before saving. These rules
   need no dashboard variables or datasource UID substitutions.

## Worker or telemetry silent

**Name:** Relay worker or telemetry silent · **Pending:** 2m · **Severity:**
critical

```promql
absent_over_time(relay_worker_heartbeats_total{job="relay/relay-worker"}[5m])
or
(sum(increase(relay_worker_heartbeats_total{job="relay/relay-worker"}[5m])) < bool 1)
```

Investigate the worker, Redis, and the Alloy → Prometheus path. This also fires
when telemetry disappears entirely; it cannot distinguish worker failure from
collector failure. Prometheus itself being unavailable produces a datasource
error and requires the contact-point routing described above.

## API server errors

**Name:** Relay API server errors · **Pending:** 5m · **Severity:** critical

```promql
(
  (sum(rate(relay_http_server_request_duration_seconds_count{job="relay/relay-api",http_response_status_class="5xx"}[5m])) or vector(0))
  / clamp_min(sum(rate(relay_http_server_request_duration_seconds_count{job="relay/relay-api"}[5m])), 0.001)
  > bool 0.05
)
and
sum(increase(relay_http_server_request_duration_seconds_count{job="relay/relay-api"}[5m])) >= 20
```

More than 5% server errors with at least 20 requests in five minutes. Check
backend logs, dependency readiness, and the latest release.

## Queue waiting too long

**Name:** Relay queue delay · **Pending:** 5m · **Severity:** warning

```promql
max(relay_queue_oldest_age_seconds{job=~"relay/relay-(api|worker)"}) > bool 300
```

Check worker health, allowances, concurrency capacity, and provider cooldowns.
An intentional pause can explain a queue delay.

## Usage settlement delayed

**Name:** Relay usage settlement delayed · **Pending:** 5m · **Severity:**
warning

```promql
max(relay_usage_settlement_lag_seconds{job=~"relay/relay-(api|worker)"}) > bool 300
```

Inspect the worker and database before changing allowances or retrying work.

## Outbox stalled

**Name:** Relay outbox stalled · **Pending:** 5m · **Severity:** warning

```promql
max(relay_outbox_oldest_age_seconds{job=~"relay/relay-(api|worker)"}) > bool 120
```

Check database connectivity, the dispatcher, and Redis. Review pending outbox
count on the dashboard to understand the backlog.

## Provider failures

**Name:** Relay provider failures · **Pending:** 5m · **Severity:** warning

```promql
(
  sum by (provider) (rate(relay_provider_outcomes_total{job="relay/relay-worker",outcome=~"failure|timeout"}[10m]))
  / clamp_min(sum by (provider) (rate(relay_provider_outcomes_total{job="relay/relay-worker"}[10m])), 0.001)
  > bool 0.2
)
and on (provider)
sum by (provider) (increase(relay_provider_outcomes_total{job="relay/relay-worker"}[10m])) >= 10
```

More than 20% failures with at least ten attempts in ten minutes. Empty data is
normal when no paid work has run. Check provider credentials, quota, and service
status; do not increase usage allowances merely to test this rule.

# Verify notifications

Use Grafana's **Test** button on the existing contact point. Then preview the
rules against live data. A health endpoint monitor should also check
`https://relay.zaftech.co/health/ready` from outside the server; the application
metrics above cannot detect a Cloudflare challenge or a broken public route.
