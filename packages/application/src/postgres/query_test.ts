import { assertEquals } from "@std/assert";
import type { HandlerRegistry } from "@relay/catalog";
import type { DatabasePool } from "@relay/database";
import type { CancellationRequestResult } from "@relay/queue";
import { PostgresWorkspaceEventService } from "./events.ts";
import { PostgresRunCancellationService } from "./runs.ts";
import { PostgresToolService } from "./tools.ts";

class ScriptedPool {
  readonly calls: Array<{ readonly text: string; readonly params: unknown[] }> =
    [];
  readonly #responses: unknown[][];

  constructor(responses: unknown[][]) {
    this.#responses = responses;
  }

  query<Row>(text: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
    this.calls.push({ text, params });
    return Promise.resolve({ rows: (this.#responses.shift() ?? []) as Row[] });
  }
}

const HEX_32 = "0123456789abcdef0123456789abcdef";

const handlers: HandlerRegistry = {
  register() {},
  unregister: () => false,
  has: () => true,
  get: (key) => ({ key, inputSchemaVersion: 1, handlerVersion: "1" }),
  isCompatible: () => true,
  keys: new Set(["image.generate.v1"]),
};

Deno.test("tool listing uses bounded keyset pagination and membership", async () => {
  const pool = new ScriptedPool([
    [{ role: "member" }],
    [{
      id: "tool_0123456789abcdef0123456789abcdef",
      key: "image.generate",
      name: "Image Generate",
      category: "image",
      summary: null,
      lifecycle: "published",
      active_version_id: "tver_0123456789abcdef0123456789abcdef",
      version: 1,
      handler_key: "image.generate.v1",
      input_schema_version: 1,
      handler_version: "1",
    }],
  ]);
  const service = new PostgresToolService(
    pool as unknown as DatabasePool,
    handlers,
  );
  const result = await service.list(
    { workspaceId: "workspace", actorUserId: "user" },
    { cursor: null, limit: 1 },
  );
  assertEquals(result.kind, "ok");
  assertEquals(pool.calls[1].params.at(-1), 2);
  assertEquals(
    pool.calls[1].text.includes("order by t.key asc, t.id asc"),
    true,
  );
  assertEquals(pool.calls[1].text.includes("auth.member"), true);
});

Deno.test("tool listing does not query resources for a non-member", async () => {
  const pool = new ScriptedPool([[]]);
  const service = new PostgresToolService(
    pool as unknown as DatabasePool,
    handlers,
  );
  assertEquals(
    await service.list(
      { workspaceId: "workspace", actorUserId: "outsider" },
      { cursor: null, limit: 25 },
    ),
    { kind: "not_found" },
  );
  assertEquals(pool.calls.length, 1);
});

function runDetailRow(status: string): Record<string, unknown> {
  const terminal = ["succeeded", "failed", "cancelled"].includes(status);
  return {
    id: `run_${HEX_32}`,
    status,
    result_completeness: null,
    input: { prompt: "A lighthouse" },
    accepted_at: "2026-08-24T10:00:00.000Z",
    started_at: "2026-08-24T10:00:01.000Z",
    terminal_at: terminal ? "2026-08-24T10:00:02.000Z" : null,
    tool_key: "image.generate",
    tool_name: "Image Generate",
    tool_version_id: `tver_${HEX_32}`,
    tool_version: 1,
    output_set_id: null,
    requested_count: null,
    produced_count: null,
    output_completeness: null,
    warnings: [],
    output_items: [],
    reservation_id: null,
    reservation_metric: null,
    reservation_unit: null,
    reservation_amount: null,
    reservation_status: null,
    reservation_expires_at: null,
  };
}

async function cancelWithFreshStatus(
  cancellation: CancellationRequestResult,
  status: string,
) {
  const pool = new ScriptedPool([
    [{ job_id: "42" }],
    [runDetailRow(status)],
  ]);
  const service = new PostgresRunCancellationService(
    pool as unknown as DatabasePool,
    (_pool, jobId) => {
      assertEquals(jobId, "42");
      return Promise.resolve(cancellation);
    },
  );
  const result = await service.cancel(
    { workspaceId: "workspace", actorUserId: "user" },
    `run_${HEX_32}`,
  );
  assertEquals(pool.calls.length, 2);
  return result;
}

Deno.test("started job outbox rows project to running events", async () => {
  const pool = new ScriptedPool([
    [{ role: "member" }],
    [{
      id: "41",
      aggregate_version: "2",
      event_type: "job.started",
      created_at: "2026-08-24T10:00:01.000Z",
      workspace_id: "workspace",
      run_id: `run_${HEX_32}`,
      run_status: "running",
    }],
  ]);
  const service = new PostgresWorkspaceEventService(
    pool as unknown as DatabasePool,
  );

  assertEquals(
    await service.list(
      { workspaceId: "workspace", actorUserId: "user" },
      { cursor: null, limit: 25 },
    ),
    {
      kind: "ok",
      items: [{
        id: "41",
        workspaceId: "workspace",
        occurredAt: "2026-08-24T10:00:01.000Z",
        event: {
          type: "run.status_changed",
          runId: `run_${HEX_32}`,
          status: "running",
        },
      }],
      nextCursor: null,
    },
  );
  assertEquals(
    (pool.calls[1].params[2] as string[]).includes("job.started"),
    true,
  );
});

Deno.test("terminal job outbox rows project to run.completed events", async () => {
  const pool = new ScriptedPool([
    [{ role: "member" }],
    [{
      id: "42",
      aggregate_version: "3",
      event_type: "job.terminal",
      created_at: "2026-08-24T10:00:02.000Z",
      workspace_id: "workspace",
      run_id: `run_${HEX_32}`,
      run_status: "succeeded",
    }],
  ]);
  const service = new PostgresWorkspaceEventService(
    pool as unknown as DatabasePool,
  );

  assertEquals(
    await service.list(
      { workspaceId: "workspace", actorUserId: "user" },
      { cursor: null, limit: 25 },
    ),
    {
      kind: "ok",
      items: [{
        id: "42",
        workspaceId: "workspace",
        occurredAt: "2026-08-24T10:00:02.000Z",
        event: {
          type: "run.completed",
          runId: `run_${HEX_32}`,
          status: "succeeded",
        },
      }],
      nextCursor: null,
    },
  );
  const publicEventTypes = pool.calls[1].params[2] as string[];
  assertEquals(publicEventTypes.includes("job.terminal"), true);
  assertEquals(
    publicEventTypes.includes("job.cancelled"),
    false,
    "scheduler-control cancellation events must not duplicate run.completed",
  );
});

Deno.test(
  "run cancellation returns the fresh terminal run when completion wins",
  async () => {
    const result = await cancelWithFreshStatus(
      { kind: "requested", running: true },
      "succeeded",
    );
    assertEquals(result.kind, "already_terminal");
    if (result.kind !== "not_found") {
      assertEquals(result.run.status, "succeeded");
    }
  },
);

Deno.test("run cancellation result kind follows the fresh run status", async () => {
  assertEquals(
    (await cancelWithFreshStatus(
      { kind: "requested", running: false },
      "cancelled",
    )).kind,
    "cancelled",
  );
  assertEquals(
    (await cancelWithFreshStatus(
      { kind: "already_requested" },
      "cancel_requested",
    )).kind,
    "cancel_requested",
  );
  assertEquals(
    (await cancelWithFreshStatus(
      { kind: "terminal_or_missing" },
      "cancelled",
    )).kind,
    "already_terminal",
  );
});
