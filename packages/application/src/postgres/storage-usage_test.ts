import { assertEquals, assertRejects } from "@std/assert";
import type { DatabasePool } from "@relay/database";
import {
  PostgresUsageService,
  type StorageUsageLimitResolver,
} from "./usage.ts";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const context = {
  workspaceId: "ws_storage_test",
  actorUserId: "user_storage_test",
};

function setup(
  row: {
    stored_bytes: string;
    reserved_bytes: string;
    cleanup_pending_bytes: string;
  } | null,
  resolveLimit: StorageUsageLimitResolver = () =>
    Promise.resolve({ kind: "limited", maxBytes: "1000" }),
) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query(sql: string, values: unknown[]) {
      calls.push({ sql, values });
      return Promise.resolve({ rows: row === null ? [] : [row] });
    },
  } as unknown as DatabasePool;
  return {
    calls,
    service: new PostgresUsageService(pool, () => NOW, resolveLimit),
  };
}

Deno.test("storage summary uses account counters and reports cleanup as part of reserved bytes", async () => {
  const { service, calls } = setup({
    stored_bytes: "400",
    reserved_bytes: "150",
    cleanup_pending_bytes: "50",
  });
  assertEquals(await service.getStorageSummary(context), {
    kind: "ok",
    storage: {
      generatedAt: NOW.toISOString(),
      storedBytes: "400",
      reservedBytes: "150",
      cleanupPendingBytes: "50",
      limitBytes: "1000",
      availableBytes: "450",
    },
  });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].values, [context.workspaceId, context.actorUserId]);
  assertEquals(calls[0].sql.includes('member."userId" = $2'), true);
  assertEquals(calls[0].sql.includes("account.committed_bytes"), true);
});

Deno.test("storage summary does not expose a missing membership as empty storage", async () => {
  let limitsRequested = 0;
  const { service } = setup(null, () => {
    limitsRequested++;
    return Promise.resolve({ kind: "limited", maxBytes: "1000" });
  });
  assertEquals(await service.getStorageSummary(context), { kind: "not_found" });
  assertEquals(limitsRequested, 0);
});

Deno.test("an unused authorized workspace has real zero usage and its configured cap", async () => {
  const { service } = setup({
    stored_bytes: "0",
    reserved_bytes: "0",
    cleanup_pending_bytes: "0",
  });
  const result = await service.getStorageSummary(context);
  assertEquals(result.kind, "ok");
  if (result.kind === "ok") {
    assertEquals(result.storage.availableBytes, "1000");
    assertEquals(result.storage.storedBytes, "0");
  }
});

Deno.test("storage availability retains bigint precision and uses a reduced effective cap", async () => {
  const row = {
    stored_bytes: "9007199254740993",
    reserved_bytes: "7",
    cleanup_pending_bytes: "2",
  };
  const { service } = setup(
    row,
    () => Promise.resolve({ kind: "limited", maxBytes: "9007199254741010" }),
  );
  const result = await service.getStorageSummary(context);
  if (result.kind !== "ok") throw new Error("Expected storage summary");
  assertEquals(result.storage.availableBytes, "10");
  assertEquals(result.storage.storedBytes, row.stored_bytes);
  const reduced = await setup(row).service.getStorageSummary(context);
  if (reduced.kind !== "ok") throw new Error("Expected storage summary");
  assertEquals(reduced.storage.limitBytes, "1000");
  assertEquals(reduced.storage.availableBytes, "0");
});

Deno.test("unlimited storage is explicit; denied, missing, invalid or failed limits stay unavailable", async () => {
  const row = {
    stored_bytes: "1",
    reserved_bytes: "0",
    cleanup_pending_bytes: "0",
  };
  const unlimited = await setup(
    row,
    () => Promise.resolve({ kind: "unlimited" }),
  ).service.getStorageSummary(context);
  if (unlimited.kind !== "ok") throw new Error("Expected storage summary");
  assertEquals(unlimited.storage.limitBytes, null);
  assertEquals(unlimited.storage.availableBytes, null);
  for (
    const resolve of [
      () => Promise.resolve({ kind: "denied", reason: "unavailable" } as const),
      () => Promise.resolve({ kind: "limited", maxBytes: "1.5" } as const),
      () => Promise.reject(new Error("limit provider unavailable")),
    ]
  ) {
    assertEquals(await setup(row, resolve).service.getStorageSummary(context), {
      kind: "unavailable",
    });
  }
  const pool = {
    query: () => Promise.resolve({ rows: [row] }),
  } as unknown as DatabasePool;
  assertEquals(
    await new PostgresUsageService(pool).getStorageSummary(context),
    { kind: "unavailable" },
  );
  const failedPool = {
    query: () => Promise.reject(new Error("database unavailable")),
  } as unknown as DatabasePool;
  await assertRejects(
    () => new PostgresUsageService(failedPool).getStorageSummary(context),
    Error,
    "database unavailable",
  );
});

Deno.test("inconsistent cleanup counters fail instead of reporting negative active uploads", async () => {
  await assertRejects(
    () =>
      setup({
        stored_bytes: "0",
        reserved_bytes: "10",
        cleanup_pending_bytes: "20",
      }).service.getStorageSummary(context),
    TypeError,
  );
});
