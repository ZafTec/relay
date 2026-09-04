import { assert, assertEquals, assertThrows } from "@std/assert";
import type { ArtifactPurgeLease, UploadCleanupLease } from "@relay/artifacts";
import type { LogRecord } from "@relay/observability";
import {
  type ArtifactMaintenanceMetric,
  type ArtifactMaintenanceService,
  createArtifactMaintenanceLoop,
} from "./artifact-maintenance.ts";

function uploadLease(uploadId: string): UploadCleanupLease {
  return {
    uploadId,
    workspaceId: "workspace-test",
    artifactId: `artifact-${uploadId}`,
    artifactVersionId: `version-${uploadId}`,
    objectKey: `private/${uploadId}`,
    storageVersionId: null,
    leaseToken: `lease-${uploadId}`,
  };
}

function purgeLease(artifactId: string): ArtifactPurgeLease {
  return {
    artifactId,
    workspaceId: "workspace-test",
    leaseToken: `purge-lease-${artifactId}`,
    objects: [],
  };
}

function fakeService(
  overrides: Partial<ArtifactMaintenanceService> = {},
): ArtifactMaintenanceService {
  return {
    expirePendingUploads: () => Promise.resolve([]),
    claimUploadCleanup: () => Promise.resolve([]),
    processUploadCleanup: () => Promise.resolve({ kind: "deleted" }),
    claimArtifactPurges: () => Promise.resolve([]),
    processArtifactPurge: () => Promise.resolve({ kind: "purged" }),
    ...overrides,
  };
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      resolvePromise?.();
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await delay(1);
  }
}

Deno.test("artifact maintenance validates bounded integer options", () => {
  const service = fakeService();
  for (
    const options of [
      { intervalMs: 0 },
      { intervalMs: 1.5 },
      { intervalMs: 86_400_001 },
      { batchSize: 0 },
      { batchSize: 101 },
      { concurrency: 0 },
      { concurrency: 101 },
    ]
  ) {
    assertThrows(
      () => createArtifactMaintenanceLoop(service, options),
      RangeError,
    );
  }
});

Deno.test("runOnce sequences subsystems and bounds lease concurrency", async () => {
  const calls: string[] = [];
  const limits: number[] = [];
  let active = 0;
  let maximumActive = 0;
  const runLease = async (kind: string, id: string): Promise<void> => {
    calls.push(`${kind}:${id}:start`);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await delay(1);
    active -= 1;
    calls.push(`${kind}:${id}:end`);
  };
  const service = fakeService({
    expirePendingUploads(limit) {
      calls.push("expire");
      limits.push(limit);
      return Promise.resolve([{
        uploadId: "expired",
        workspaceId: "workspace-test",
        artifactId: "artifact-expired",
        artifactVersionId: "version-expired",
        objectKey: "private/expired",
      }]);
    },
    claimUploadCleanup(limit) {
      calls.push("claim-upload-cleanup");
      limits.push(limit);
      return Promise.resolve([
        uploadLease("upload-1"),
        uploadLease("upload-2"),
        uploadLease("upload-3"),
      ]);
    },
    async processUploadCleanup(lease) {
      await runLease("cleanup", lease.uploadId);
      return { kind: "deleted" };
    },
    claimArtifactPurges(limit) {
      calls.push("claim-artifact-purges");
      limits.push(limit);
      return Promise.resolve([
        purgeLease("artifact-1"),
        purgeLease("artifact-2"),
      ]);
    },
    async processArtifactPurge(lease) {
      await runLease("purge", lease.artifactId);
      return { kind: "purged" };
    },
  });
  const maintenance = createArtifactMaintenanceLoop(service, {
    intervalMs: 100,
    batchSize: 3,
    concurrency: 2,
    log() {},
  });

  const result = await maintenance.runOnce();

  assertEquals(limits, [3, 3, 3]);
  assertEquals(maximumActive, 2);
  assert(
    calls.indexOf("expire") < calls.indexOf("claim-upload-cleanup"),
  );
  assert(
    calls.lastIndexOf("cleanup:upload-3:end") <
      calls.indexOf("claim-artifact-purges"),
  );
  assert(
    calls.indexOf("claim-artifact-purges") <
      calls.indexOf("purge:artifact-1:start"),
  );
  assertEquals(result, {
    expiration: { expired: 1, failed: 0 },
    uploadCleanup: {
      claimed: 3,
      deleted: 3,
      retryScheduled: 0,
      leaseLost: 0,
      failed: 0,
    },
    artifactPurge: {
      claimed: 2,
      purged: 2,
      retryScheduled: 0,
      leaseLost: 0,
      failed: 0,
    },
    aborted: false,
  });
  await maintenance.stop();
});

Deno.test("lease and subsystem failures do not block remaining work", async () => {
  const secret = "Bearer artifact-maintenance-secret";
  const cleaned: string[] = [];
  const purged: string[] = [];
  const logs: LogRecord[] = [];
  const metrics: ArtifactMaintenanceMetric[] = [];
  const service = fakeService({
    expirePendingUploads() {
      return Promise.reject(new Error(secret));
    },
    claimUploadCleanup() {
      return Promise.resolve([
        uploadLease("upload-1"),
        uploadLease("upload-2"),
        uploadLease("upload-3"),
      ]);
    },
    processUploadCleanup(lease) {
      cleaned.push(lease.uploadId);
      if (lease.uploadId === "upload-2") {
        return Promise.reject(new Error(secret));
      }
      return Promise.resolve(
        lease.uploadId === "upload-3"
          ? { kind: "retry_scheduled" as const }
          : { kind: "deleted" as const },
      );
    },
    claimArtifactPurges() {
      return Promise.resolve([purgeLease("artifact-1")]);
    },
    processArtifactPurge(lease) {
      purged.push(lease.artifactId);
      return Promise.resolve({ kind: "purged" });
    },
  });
  const maintenance = createArtifactMaintenanceLoop(service, {
    intervalMs: 100,
    batchSize: 3,
    concurrency: 3,
    log(record) {
      logs.push(record);
      throw new Error("log callback failed");
    },
    onMetric(metric) {
      metrics.push(metric);
      if (metrics.length === 1) throw new Error("metric callback failed");
    },
  });

  const result = await maintenance.runOnce();

  assertEquals(cleaned, ["upload-1", "upload-2", "upload-3"]);
  assertEquals(purged, ["artifact-1"]);
  assertEquals(result.expiration, { expired: 0, failed: 1 });
  assertEquals(result.uploadCleanup, {
    claimed: 3,
    deleted: 1,
    retryScheduled: 1,
    leaseLost: 0,
    failed: 1,
  });
  assertEquals(result.artifactPurge.purged, 1);
  assertEquals(logs.length, 2);
  assertEquals(
    logs.every((record) => record["error.type"] === "dependency"),
    true,
  );
  assertEquals(JSON.stringify(logs).includes(secret), false);
  assert(
    metrics.some((metric) =>
      metric.operation === "expire_pending_uploads" &&
      metric.outcome === "failure" && metric.value === 1
    ),
  );
  assert(
    metrics.some((metric) =>
      metric.operation === "process_upload_cleanup" &&
      metric.outcome === "failure" && metric.value === 1
    ),
  );
  assert(
    metrics.some((metric) =>
      metric.operation === "process_artifact_purge" &&
      metric.outcome === "purged" && metric.value === 1
    ),
  );
  await maintenance.stop();
});

Deno.test("the supervised loop survives a failed iteration subsystem", async () => {
  let expirations = 0;
  let cleanupClaims = 0;
  let purgeClaims = 0;
  const service = fakeService({
    expirePendingUploads() {
      expirations += 1;
      return Promise.resolve([]);
    },
    claimUploadCleanup() {
      cleanupClaims += 1;
      return cleanupClaims === 1
        ? Promise.reject(new Error("first cleanup claim failed"))
        : Promise.resolve([]);
    },
    claimArtifactPurges() {
      purgeClaims += 1;
      return Promise.resolve([]);
    },
  });
  const maintenance = createArtifactMaintenanceLoop(service, {
    intervalMs: 1,
    batchSize: 1,
    concurrency: 1,
    log() {},
  });

  const running = maintenance.start();
  await waitFor(() =>
    expirations >= 2 && cleanupClaims >= 2 && purgeClaims >= 2
  );
  await maintenance.stop();
  await running;

  assert(expirations >= 2);
  assert(cleanupClaims >= 2);
  assert(purgeClaims >= 2);
});

Deno.test("abort stops claims and drains every already-claimed lease", async () => {
  const abort = new AbortController();
  const firstLeaseStarted = deferred();
  const releaseFirstLease = deferred();
  const processed: string[] = [];
  let expirations = 0;
  let cleanupClaims = 0;
  let purgeClaims = 0;
  const service = fakeService({
    expirePendingUploads() {
      expirations += 1;
      return Promise.resolve([]);
    },
    claimUploadCleanup() {
      cleanupClaims += 1;
      return Promise.resolve([
        uploadLease("upload-1"),
        uploadLease("upload-2"),
      ]);
    },
    async processUploadCleanup(lease) {
      processed.push(lease.uploadId);
      if (lease.uploadId === "upload-1") {
        firstLeaseStarted.resolve();
        await releaseFirstLease.promise;
      }
      return { kind: "deleted" };
    },
    claimArtifactPurges() {
      purgeClaims += 1;
      return Promise.resolve([]);
    },
  });
  const maintenance = createArtifactMaintenanceLoop(service, {
    intervalMs: 1,
    batchSize: 2,
    concurrency: 1,
    signal: abort.signal,
    log() {},
  });
  const running = maintenance.start();

  try {
    await firstLeaseStarted.promise;
    let drained = false;
    void running.then(() => {
      drained = true;
    });
    abort.abort();
    await delay(5);
    assertEquals(drained, false);

    releaseFirstLease.resolve();
    await running;
    assertEquals(processed, ["upload-1", "upload-2"]);
    assertEquals(expirations, 1);
    assertEquals(cleanupClaims, 1);
    assertEquals(purgeClaims, 0);

    const afterAbort = await maintenance.runOnce();
    await delay(5);
    assertEquals(afterAbort.aborted, true);
    assertEquals(expirations, 1);
    assertEquals(cleanupClaims, 1);
    assertEquals(purgeClaims, 0);
  } finally {
    releaseFirstLease.resolve();
    await maintenance.stop();
    await running;
  }
});

Deno.test("stop before start permanently prevents maintenance claims", async () => {
  let calls = 0;
  const service = fakeService({
    expirePendingUploads() {
      calls += 1;
      return Promise.resolve([]);
    },
    claimUploadCleanup() {
      calls += 1;
      return Promise.resolve([]);
    },
    claimArtifactPurges() {
      calls += 1;
      return Promise.resolve([]);
    },
  });
  const maintenance = createArtifactMaintenanceLoop(service, {
    intervalMs: 1,
    batchSize: 1,
    concurrency: 1,
    log() {},
  });

  await maintenance.stop();
  assertEquals((await maintenance.runOnce()).aborted, true);
  await maintenance.start();
  await delay(5);
  assertEquals(calls, 0);
});
