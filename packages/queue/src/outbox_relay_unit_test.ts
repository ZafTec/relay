import { assertEquals } from "@std/assert";
import {
  claimOutboxBatch,
  finalizeExpiredOutboxAttempts,
  markOutboxFailed,
  markOutboxPublished,
  type OutboxEventRow,
  type Queryable,
  relayOutboxBatch,
} from "./outbox-relay.ts";

interface QueryCall {
  readonly text: string;
  readonly params: readonly unknown[];
}

class ScriptedQueryable implements Queryable {
  readonly calls: QueryCall[] = [];

  constructor(private readonly responses: readonly unknown[][]) {}

  query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    this.calls.push({ text, params });
    const rows = this.responses[this.calls.length - 1] ?? [];
    return Promise.resolve({ rows: rows as T[] });
  }
}

function event(overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    id: "42",
    aggregateType: "execution_job",
    aggregateId: "9",
    aggregateVersion: "3",
    eventType: "job.ready",
    payload: {},
    attemptCount: 2,
    leaseOwner: "relay-a",
    ...overrides,
  };
}

Deno.test("outbox claim excludes exhausted rows and returns its finalization fence", async () => {
  const db = new ScriptedQueryable([[{
    id: "42",
    aggregate_type: "execution_job",
    aggregate_id: "9",
    aggregate_version: "3",
    event_type: "job.ready",
    payload: {},
    attempt_count: 2,
    lease_owner: "relay-a",
  }]]);
  const claimed = await claimOutboxBatch(
    db,
    "relay-a",
    30_000,
    10,
    4,
    ["job.ready"],
  );
  assertEquals(claimed, [event()]);
  assertEquals(db.calls[0].text.includes("failed_at is null"), true);
  assertEquals(db.calls[0].text.includes("attempt_count < $4"), true);
  assertEquals(db.calls[0].params, [
    "relay-a",
    30_000,
    10,
    4,
    ["job.ready"],
  ]);
});

Deno.test("expired final claims are terminalized instead of stranded", async () => {
  const db = new ScriptedQueryable([[{ count: 2 }]]);
  assertEquals(
    await finalizeExpiredOutboxAttempts(db, 4, ["job.ready"]),
    2,
  );
  assertEquals(db.calls[0].params, [4, ["job.ready"]]);
  assertEquals(db.calls[0].text.includes("attempt_count >= $1"), true);
  assertEquals(db.calls[0].text.includes("failed_at = now()"), true);
});

Deno.test("outbox publication requires owner and exact claim attempt", async () => {
  const won = new ScriptedQueryable([[{ id: "42" }]]);
  assertEquals(await markOutboxPublished(won, event()), true);
  assertEquals(won.calls[0].params, ["42", "relay-a", 2]);
  assertEquals(won.calls[0].text.includes("lease_owner = $2"), true);
  assertEquals(won.calls[0].text.includes("attempt_count = $3"), true);

  const stale = new ScriptedQueryable([[]]);
  assertEquals(
    await markOutboxPublished(stale, event({ leaseOwner: "stale-relay" })),
    false,
  );
});

Deno.test("outbox failure redacts and bounds errors before jittered retry", async () => {
  const db = new ScriptedQueryable([[{ id: "42" }]]);
  const secret = "very-secret-token";
  const result = await markOutboxFailed(
    db,
    event({ attemptCount: 2 }),
    new Error(`Authorization: Bearer ${secret} ${"x".repeat(800)}`),
    {
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      jitterRatio: 0.2,
      random: () => 0.5,
    },
  );
  assertEquals(result, {
    finalized: true,
    exhausted: false,
    retryDelayMs: 200,
  });
  const storedError = String(db.calls[0].params[3]);
  assertEquals(storedError.includes(secret), false);
  assertEquals(storedError.length <= 512, true);
  assertEquals(db.calls[0].params[4], 200);
  assertEquals(db.calls[0].text.includes("eligible_at"), true);
});

Deno.test("outbox attempt ceiling terminalizes a poison event", async () => {
  const db = new ScriptedQueryable([[{ id: "42" }]]);
  const result = await markOutboxFailed(
    db,
    event({ attemptCount: 4 }),
    "publish failed",
    {
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      jitterRatio: 0,
    },
  );
  assertEquals(result, { finalized: true, exhausted: true });
  assertEquals(db.calls[0].text.includes("failed_at = now()"), true);
  assertEquals(db.calls[0].params.length, 4);
});

Deno.test("publish-before-ack crash is reported as a lost lease for redelivery", async () => {
  const row = {
    id: "42",
    aggregate_type: "execution_job",
    aggregate_id: "9",
    aggregate_version: "3",
    event_type: "job.ready",
    payload: {},
    attempt_count: 1,
    lease_owner: "relay-a",
  };
  const db = new ScriptedQueryable([[{ count: 0 }], [row], []]);
  let publications = 0;
  const result = await relayOutboxBatch(
    db,
    () => {
      publications += 1;
      return Promise.resolve();
    },
    { leaseOwner: "relay-a" },
  );
  assertEquals(publications, 1);
  assertEquals(result, {
    claimed: 1,
    published: 0,
    failed: 0,
    exhausted: 0,
    lostLease: 1,
  });
});
