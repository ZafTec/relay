import { assertEquals } from "@std/assert";
import type {
  GaugeObserver,
  RelayCounterMetricName,
  RelayObservableGaugeMetricName,
  TelemetryAttributes,
} from "@relay/observability";
import { createWorkerRuntimeMetrics } from "./metrics.ts";

Deno.test("worker gauges expose only aggregate bounded dimensions", async () => {
  const observers = new Map<RelayObservableGaugeMetricName, GaugeObserver>();
  const counters: Array<{
    name: RelayCounterMetricName;
    value: number;
    attributes?: TelemetryAttributes;
  }> = [];
  let query = 0;
  const metrics = createWorkerRuntimeMetrics(
    {
      query<T>() {
        query += 1;
        const rows = query === 1
          ? [{ waiting: 7, active: 2, oldest_age_seconds: 12.5 }]
          : [{ pending: 3, oldest_age_seconds: 4.25 }];
        return Promise.resolve({ rows: rows as T[] });
      },
    },
    {
      counter(name) {
        return {
          add(value, attributes) {
            counters.push({ name, value, attributes });
          },
        };
      },
      observableGauge(name, observer) {
        observers.set(name, observer);
        return { dispose() {} };
      },
    },
  );

  await metrics.refresh();
  metrics.heartbeat();
  metrics.recordReconciledJobs(2);

  const observations: Array<{
    name: RelayObservableGaugeMetricName;
    value: number;
    attributes?: TelemetryAttributes;
  }> = [];
  for (const [name, observer] of observers) {
    observer((value, attributes) => {
      observations.push({ name, value, attributes });
    });
  }

  assertEquals(observations, [
    {
      name: "relay.queue.depth",
      value: 7,
      attributes: { "queue.name": "execution", "job.state": "waiting" },
    },
    {
      name: "relay.queue.depth",
      value: 2,
      attributes: { "queue.name": "execution", "job.state": "active" },
    },
    {
      name: "relay.queue.oldest_age",
      value: 12.5,
      attributes: { "queue.name": "execution" },
    },
    {
      name: "relay.outbox.pending",
      value: 3,
      attributes: { operation: "dispatch" },
    },
    {
      name: "relay.outbox.oldest_age",
      value: 4.25,
      attributes: { operation: "dispatch" },
    },
  ]);
  assertEquals(counters, [
    { name: "relay.worker.heartbeats", value: 1, attributes: undefined },
    {
      name: "relay.job.stalls",
      value: 2,
      attributes: { "queue.name": "execution" },
    },
  ]);
  assertEquals(JSON.stringify(observations).includes("job-private"), false);
});

Deno.test("worker metric refresh and emit failures are fail-open", async () => {
  const metrics = createWorkerRuntimeMetrics(
    {
      query() {
        return Promise.reject(new Error("metrics query failed"));
      },
    },
    {
      counter() {
        return {
          add() {
            throw new Error("metric export failed");
          },
        };
      },
      observableGauge() {
        throw new Error("metric registration failed");
      },
    },
  );

  await metrics.refresh();
  metrics.heartbeat();
  metrics.recordReconciledJobs(1);
  metrics.dispose();
});
