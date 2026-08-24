import type {
  GaugeObserver,
  ObservableGaugeRegistration,
  RelayObservableGaugeMetricName,
  RelayTelemetry,
  SafeCounter,
} from "@relay/observability";

interface MetricQueryable {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

interface WorkerMetricSnapshot {
  waiting: number;
  active: number;
  oldestQueueAgeSeconds: number;
  outboxPending: number;
  oldestOutboxAgeSeconds: number;
}

export interface WorkerRuntimeMetrics {
  heartbeat(): void;
  recordReconciledJobs(value: number): void;
  refresh(): Promise<void>;
  dispose(): void;
}

const NOOP_COUNTER: SafeCounter = { add() {} };
const NOOP_REGISTRATION: ObservableGaugeRegistration = { dispose() {} };

function nonnegative(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function safeCounter(
  telemetry: Pick<RelayTelemetry, "counter">,
  name: "relay.worker.heartbeats" | "relay.job.stalls",
): SafeCounter {
  try {
    return telemetry.counter(name);
  } catch {
    return NOOP_COUNTER;
  }
}

function safeGauge(
  telemetry: Pick<RelayTelemetry, "observableGauge">,
  name: RelayObservableGaugeMetricName,
  observer: GaugeObserver,
): ObservableGaugeRegistration {
  try {
    return telemetry.observableGauge(name, observer);
  } catch {
    return NOOP_REGISTRATION;
  }
}

/**
 * Registers process-local gauges backed by bounded aggregate SQL only. Refresh
 * failures retain the last snapshot and never alter worker control flow.
 */
export function createWorkerRuntimeMetrics(
  queryable: MetricQueryable,
  telemetry: Pick<RelayTelemetry, "counter" | "observableGauge">,
): WorkerRuntimeMetrics {
  let snapshot: WorkerMetricSnapshot = {
    waiting: 0,
    active: 0,
    oldestQueueAgeSeconds: 0,
    outboxPending: 0,
    oldestOutboxAgeSeconds: 0,
  };
  const heartbeats = safeCounter(telemetry, "relay.worker.heartbeats");
  const stalls = safeCounter(telemetry, "relay.job.stalls");
  let refreshing = false;
  const registrations = [
    safeGauge(telemetry, "relay.queue.depth", (observe) => {
      observe(snapshot.waiting, {
        "queue.name": "execution",
        "job.state": "waiting",
      });
      observe(snapshot.active, {
        "queue.name": "execution",
        "job.state": "active",
      });
    }),
    safeGauge(telemetry, "relay.queue.oldest_age", (observe) => {
      observe(snapshot.oldestQueueAgeSeconds, { "queue.name": "execution" });
    }),
    safeGauge(telemetry, "relay.outbox.pending", (observe) => {
      observe(snapshot.outboxPending, { operation: "dispatch" });
    }),
    safeGauge(telemetry, "relay.outbox.oldest_age", (observe) => {
      observe(snapshot.oldestOutboxAgeSeconds, { operation: "dispatch" });
    }),
  ];

  return {
    heartbeat() {
      try {
        heartbeats.add(1);
      } catch {
        // A custom test double must not weaken the telemetry failure boundary.
      }
    },
    recordReconciledJobs(value: number) {
      if (!Number.isFinite(value) || value <= 0) return;
      try {
        stalls.add(value, { "queue.name": "execution" });
      } catch {
        // Reconciliation is authoritative; recording its result is best effort.
      }
    },
    async refresh() {
      if (refreshing) return;
      refreshing = true;
      try {
        const [queue, outbox] = await Promise.all([
          queryable.query<{
            waiting: string | number;
            active: string | number;
            oldest_age_seconds: string | number;
          }>(
            `select count(*) filter (where status = 'queued')::integer as waiting,
                    count(*) filter (
                      where status in ('running', 'cancel_requested')
                    )::integer as active,
                    coalesce(extract(epoch from (
                      now() - min(accepted_at) filter (where status = 'queued')
                    )), 0)::double precision as oldest_age_seconds
               from relay.execution_jobs`,
          ),
          queryable.query<{
            pending: string | number;
            oldest_age_seconds: string | number;
          }>(
            `select count(*)::integer as pending,
                    coalesce(extract(epoch from (now() - min(created_at))), 0)
                      ::double precision as oldest_age_seconds
               from relay.outbox_events
              where published_at is null and failed_at is null`,
          ),
        ]);
        const queueRow = queue.rows[0];
        const outboxRow = outbox.rows[0];
        snapshot = {
          waiting: nonnegative(queueRow?.waiting),
          active: nonnegative(queueRow?.active),
          oldestQueueAgeSeconds: nonnegative(queueRow?.oldest_age_seconds),
          outboxPending: nonnegative(outboxRow?.pending),
          oldestOutboxAgeSeconds: nonnegative(
            outboxRow?.oldest_age_seconds,
          ),
        };
      } catch {
        // Observability queries must never make dispatch or reconciliation fail.
      } finally {
        refreshing = false;
      }
    },
    dispose() {
      for (const registration of registrations) {
        try {
          registration.dispose();
        } catch {
          // Shutdown telemetry cleanup is best effort.
        }
      }
    },
  };
}
