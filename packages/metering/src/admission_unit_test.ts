import { assertEquals, assertRejects } from "@std/assert";
import { reserveUsageForAdmission } from "./admission.ts";
import {
  type MeteringTransaction,
  withMeteringTransaction,
} from "./transaction.ts";
import type { MeteringQueryExecutor } from "./types.ts";

Deno.test("admission requires a branded transaction and authorizes first", async () => {
  const calls: string[] = [];
  const queryable: MeteringQueryExecutor = {
    query<Row>(text: string): Promise<{ rows: Row[] }> {
      calls.push(text);
      if (
        text.startsWith("savepoint ") || text.startsWith("release savepoint ")
      ) {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes("pg_advisory_xact_lock")) {
        return Promise.resolve({ rows: [{}] as Row[] });
      }
      if (text.includes("from auth.member")) {
        return Promise.resolve({ rows: [] });
      }
      throw new Error(`resource lookup occurred before authorization: ${text}`);
    },
  };
  const input = {
    actorUserId: "user_outside",
    workspaceId: "org_private",
    toolVersionId: "tver_unknown",
    providerModelId: "1",
    measures: {},
    idempotencyKey: "fixture-key",
    reservationTtlSeconds: 60,
  };

  await assertRejects(
    () =>
      reserveUsageForAdmission(
        queryable as unknown as MeteringTransaction,
        input,
      ),
    TypeError,
    "withMeteringTransaction",
  );
  assertEquals(calls, []);

  const result = await withMeteringTransaction(
    queryable,
    (transaction) => reserveUsageForAdmission(transaction, input),
  );

  assertEquals(result, { kind: "workspace_unavailable" });
  assertEquals(calls.length, 4);
  assertEquals(calls.some((sql) => sql.includes("usage_reservations")), false);
  assertEquals(calls.some((sql) => sql.includes("tool_versions")), false);
});
