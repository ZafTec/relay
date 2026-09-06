import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { ArtifactQueryable } from "./database.ts";
import {
  ArtifactQuotaConflictError,
  ArtifactQuotaLimitError,
  artifactStorageByteString,
  type ArtifactStorageLimitDecision,
  type ArtifactStorageLimitProvider,
  PostgresArtifactQuota,
} from "./postgres-quota.ts";

interface ReservationState {
  id: string;
  workspace_id: string;
  operation_id: string;
  reserved_bytes: string;
  status: "reserved" | "committed" | "released" | "decremented";
}

interface AccountState {
  limit: bigint;
  reserved: bigint;
  committed: bigint;
}

class MemoryQuotaDatabase implements ArtifactQueryable {
  readonly accounts = new Map<string, AccountState>();
  readonly reservations = new Map<string, ReservationState>();
  readonly calls: { text: string; params: unknown[] }[] = [];

  query<Row>(text: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
    this.calls.push({ text, params });
    const sql = text.replaceAll(/\s+/g, " ").trim();
    let rows: unknown[];

    if (sql.includes("pg_advisory_xact_lock")) {
      rows = [];
    } else if (
      sql.startsWith("select id, workspace_id") &&
      sql.includes("operation_id = $2")
    ) {
      const [workspaceId, operationId] = params as string[];
      const reservation = [...this.reservations.values()].find((candidate) =>
        candidate.workspace_id === workspaceId &&
        candidate.operation_id === operationId
      );
      rows = reservation === undefined ? [] : [{ ...reservation }];
    } else if (
      sql.startsWith("select id, workspace_id") && sql.includes("id = $2")
    ) {
      const [workspaceId, reservationId] = params as string[];
      const reservation = this.reservations.get(reservationId);
      rows = reservation?.workspace_id === workspaceId
        ? [{ ...reservation }]
        : [];
    } else if (sql.startsWith("insert into relay.artifact_storage_accounts")) {
      const [workspaceId, rawLimit] = params as string[];
      const limit = BigInt(rawLimit);
      const account = this.accounts.get(workspaceId);
      if (account === undefined) {
        this.accounts.set(workspaceId, {
          limit,
          reserved: 0n,
          committed: 0n,
        });
      } else {
        const allocated = account.reserved + account.committed;
        account.limit = limit > allocated ? limit : allocated;
      }
      rows = [];
    } else if (sql.includes("reserved_bytes = reserved_bytes + $2::bigint")) {
      const [workspaceId, rawBytes, rawLimit] = params as string[];
      const account = this.accounts.get(workspaceId)!;
      const bytes = BigInt(rawBytes);
      const limit = BigInt(rawLimit);
      if (account.committed + account.reserved + bytes > limit) {
        rows = [];
      } else {
        account.limit = limit;
        account.reserved += bytes;
        rows = [{ workspace_id: workspaceId }];
      }
    } else if (
      sql.startsWith("insert into relay.artifact_storage_reservations")
    ) {
      const [id, workspaceId, operationId, bytes] = params as string[];
      const reservation: ReservationState = {
        id,
        workspace_id: workspaceId,
        operation_id: operationId,
        reserved_bytes: bytes,
        status: "reserved",
      };
      this.reservations.set(id, reservation);
      rows = [{ id }];
    } else if (
      sql.includes("reserved_bytes = reserved_bytes - $2::bigint") &&
      sql.includes("committed_bytes = committed_bytes + $2::bigint")
    ) {
      const [workspaceId, rawBytes] = params as string[];
      const account = this.accounts.get(workspaceId);
      const bytes = BigInt(rawBytes);
      if (account === undefined || account.reserved < bytes) {
        rows = [];
      } else {
        account.reserved -= bytes;
        account.committed += bytes;
        rows = [{ workspace_id: workspaceId }];
      }
    } else if (
      sql.includes("set reserved_bytes = reserved_bytes - $2::bigint")
    ) {
      const [workspaceId, rawBytes] = params as string[];
      const account = this.accounts.get(workspaceId);
      const bytes = BigInt(rawBytes);
      if (account === undefined || account.reserved < bytes) {
        rows = [];
      } else {
        account.reserved -= bytes;
        rows = [{ workspace_id: workspaceId }];
      }
    } else if (
      sql.includes("set committed_bytes = committed_bytes - $2::bigint")
    ) {
      const [workspaceId, rawBytes] = params as string[];
      const account = this.accounts.get(workspaceId);
      const bytes = BigInt(rawBytes);
      if (account === undefined || account.committed < bytes) {
        rows = [];
      } else {
        account.committed -= bytes;
        rows = [{ workspace_id: workspaceId }];
      }
    } else if (sql.includes("set status = 'committed'")) {
      const [workspaceId, reservationId] = params as string[];
      const reservation = this.reservations.get(reservationId);
      if (
        reservation?.workspace_id !== workspaceId ||
        reservation.status !== "reserved"
      ) {
        rows = [];
      } else {
        reservation.status = "committed";
        rows = [{ id: reservationId }];
      }
    } else if (sql.includes("set status = 'released'")) {
      const [workspaceId, reservationId] = params as string[];
      const reservation = this.reservations.get(reservationId);
      if (
        reservation?.workspace_id !== workspaceId ||
        reservation.status !== "reserved"
      ) {
        rows = [];
      } else {
        reservation.status = "released";
        rows = [{ id: reservationId }];
      }
    } else if (sql.includes("set status = 'decremented'")) {
      const [workspaceId, reservationId] = params as string[];
      const reservation = this.reservations.get(reservationId);
      if (
        reservation?.workspace_id !== workspaceId ||
        reservation.status !== "committed"
      ) {
        rows = [];
      } else {
        reservation.status = "decremented";
        rows = [{ id: reservationId }];
      }
    } else {
      throw new Error(`Unexpected query: ${sql}`);
    }

    return Promise.resolve({ rows: rows as Row[] });
  }
}

class FixedLimitProvider implements ArtifactStorageLimitProvider {
  calls = 0;

  constructor(public decision: ArtifactStorageLimitDecision) {}

  getLimit(): Promise<ArtifactStorageLimitDecision> {
    this.calls += 1;
    return Promise.resolve(this.decision);
  }
}

function account(database: MemoryQuotaDatabase, workspaceId: string) {
  const value = database.accounts.get(workspaceId);
  return {
    reserved: value?.reserved.toString() ?? "0",
    committed: value?.committed.toString() ?? "0",
  };
}

Deno.test("artifact byte strings preserve PostgreSQL bigint precision", () => {
  assertEquals(artifactStorageByteString(0), "0");
  assertEquals(
    artifactStorageByteString(9_007_199_254_740_991),
    "9007199254740991",
  );
  assertEquals(
    artifactStorageByteString("9223372036854775807"),
    "9223372036854775807",
  );
  assertEquals(
    artifactStorageByteString(9223372036854775807n),
    "9223372036854775807",
  );
  assertThrows(() => artifactStorageByteString(-1), TypeError);
  assertThrows(() => artifactStorageByteString("01"), TypeError);
  assertThrows(
    () => artifactStorageByteString("9223372036854775808"),
    TypeError,
  );
  assertThrows(() => artifactStorageByteString(Number.MAX_VALUE), TypeError);
});

Deno.test("PostgreSQL quota reserves atomically and replays without double counting", async () => {
  const database = new MemoryQuotaDatabase();
  const provider = new FixedLimitProvider({ kind: "limited", maxBytes: "10" });
  let sequence = 0;
  const quota = new PostgresArtifactQuota({
    limitProvider: provider,
    generateReservationId: () => `reservation-${++sequence}`,
  });

  const first = await quota.reserve(database, {
    workspaceId: "workspace-1",
    operationId: "upload-1",
    bytes: 7,
  });
  assertEquals(first, { kind: "reserved", reservationId: "reservation-1" });
  assertEquals(account(database, "workspace-1"), {
    reserved: "7",
    committed: "0",
  });

  assertEquals(
    await quota.reserve(database, {
      workspaceId: "workspace-1",
      operationId: "upload-1",
      bytes: 7,
    }),
    first,
  );
  assertEquals(provider.calls, 1);
  assertEquals(account(database, "workspace-1").reserved, "7");

  assertEquals(
    await quota.reserve(database, {
      workspaceId: "workspace-1",
      operationId: "upload-2",
      bytes: 4,
    }),
    { kind: "denied" },
  );
  assertEquals(account(database, "workspace-1").reserved, "7");
  assertEquals(database.reservations.size, 1);

  const byteParameters = database.calls
    .filter((call) => call.text.includes("$2::bigint"))
    .map((call) => call.params[1]);
  assertEquals(
    byteParameters.every((value) => typeof value === "string"),
    true,
  );
});

Deno.test("quota commit, release, and decrement are idempotent", async () => {
  const database = new MemoryQuotaDatabase();
  const provider = new FixedLimitProvider({ kind: "unlimited" });
  let sequence = 0;
  const quota = new PostgresArtifactQuota({
    limitProvider: provider,
    generateReservationId: () => `reservation-${++sequence}`,
  });
  const first = await quota.reserve(database, {
    workspaceId: "workspace-1",
    operationId: "upload-1",
    bytes: 7,
  });
  const second = await quota.reserve(database, {
    workspaceId: "workspace-1",
    operationId: "upload-2",
    bytes: 3,
  });
  if (first.kind !== "reserved" || second.kind !== "reserved") {
    throw new Error("expected reservations");
  }

  const commit = {
    workspaceId: "workspace-1",
    reservationId: first.reservationId,
    bytes: 7,
  };
  await quota.commit(database, commit);
  await quota.commit(database, commit);
  assertEquals(account(database, "workspace-1"), {
    reserved: "3",
    committed: "7",
  });

  const release = {
    workspaceId: "workspace-1",
    reservationId: second.reservationId,
    bytes: 3,
  };
  await quota.release(database, release);
  await quota.release(database, release);
  assertEquals(account(database, "workspace-1"), {
    reserved: "0",
    committed: "7",
  });
  await assertRejects(
    () =>
      quota.reserve(database, {
        workspaceId: "workspace-1",
        operationId: "upload-2",
        bytes: 3,
      }),
    ArtifactQuotaConflictError,
    "terminal",
  );

  const decrement = {
    workspaceId: "workspace-1",
    reservationId: first.reservationId,
    operationId: "purge-version-1",
    bytes: 7,
  };
  await quota.decrementCommitted(database, decrement);
  await quota.decrementCommitted(database, decrement);
  await quota.commit(database, commit);
  assertEquals(account(database, "workspace-1"), {
    reserved: "0",
    committed: "0",
  });
});

Deno.test("quota replays reject changed byte counts", async () => {
  const database = new MemoryQuotaDatabase();
  const provider = new FixedLimitProvider({ kind: "unlimited" });
  const quota = new PostgresArtifactQuota({
    limitProvider: provider,
    generateReservationId: () => "reservation-1",
  });
  const first = await quota.reserve(database, {
    workspaceId: "workspace-1",
    operationId: "upload-1",
    bytes: 2,
  });
  if (first.kind !== "reserved") throw new Error("expected reservation");

  await assertRejects(
    () =>
      quota.reserve(database, {
        workspaceId: "workspace-1",
        operationId: "upload-1",
        bytes: 3,
      }),
    ArtifactQuotaConflictError,
  );
  await quota.commit(database, {
    workspaceId: "workspace-1",
    reservationId: first.reservationId,
    bytes: 2,
  });
  await assertRejects(
    () =>
      quota.decrementCommitted(database, {
        workspaceId: "workspace-1",
        reservationId: first.reservationId,
        operationId: "purge-1",
        bytes: 3,
      }),
    ArtifactQuotaConflictError,
  );
});

Deno.test("quota limit resolution fails closed", async () => {
  for (
    const decision of [
      { kind: "denied", reason: "not_configured" },
      { kind: "denied", reason: "unavailable" },
    ] as const
  ) {
    const database = new MemoryQuotaDatabase();
    const quota = new PostgresArtifactQuota({
      limitProvider: new FixedLimitProvider(decision),
    });
    assertEquals(
      await quota.reserve(database, {
        workspaceId: "workspace-1",
        operationId: `upload-${decision.reason}`,
        bytes: 1,
      }),
      { kind: "denied" },
    );
    assertEquals(database.accounts.size, 0);
    assertEquals(database.reservations.size, 0);
  }

  const throwingQuota = new PostgresArtifactQuota({
    limitProvider: {
      getLimit: () => Promise.reject(new Error("configuration unavailable")),
    },
  });
  await assertRejects(
    () =>
      throwingQuota.reserve(new MemoryQuotaDatabase(), {
        workspaceId: "workspace-1",
        operationId: "upload-error",
        bytes: 1,
      }),
    ArtifactQuotaLimitError,
    "could not be resolved",
  );

  const malformedQuota = new PostgresArtifactQuota({
    limitProvider: {
      getLimit: () =>
        Promise.resolve({ kind: "limited", maxBytes: "unbounded" }),
    },
  });
  await assertRejects(
    () =>
      malformedQuota.reserve(new MemoryQuotaDatabase(), {
        workspaceId: "workspace-1",
        operationId: "upload-malformed",
        bytes: 1,
      }),
    ArtifactQuotaLimitError,
    "invalid limit",
  );
});
