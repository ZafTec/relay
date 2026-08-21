import { assertEquals } from "@std/assert";
import { createDatabasePool } from "./pool.ts";
import { checkDatabaseHealth } from "./health.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const hasDatabase = databaseUrl !== undefined;

Deno.test({
  name: "checkDatabaseHealth reports ok against a reachable database",
  ignore: !hasDatabase,
  fn: async () => {
    const pool = createDatabasePool(
      {
        url: new URL(databaseUrl!),
        poolMax: 2,
        connectTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
      },
      "relay-api",
    );

    try {
      assertEquals(await checkDatabaseHealth(pool), {
        name: "database",
        status: "ok",
      });
    } finally {
      await pool.end();
    }
  },
});

Deno.test("checkDatabaseHealth reports a sanitized error against an unreachable database", async () => {
  const pool = createDatabasePool(
    {
      url: new URL("postgres://user:pass@127.0.0.1:1/does-not-exist"),
      poolMax: 1,
      connectTimeoutMs: 300,
      statementTimeoutMs: 1_000,
    },
    "relay-api",
  );

  try {
    const result = await checkDatabaseHealth(pool);
    assertEquals(result.name, "database");
    assertEquals(result.status, "error");
    assertEquals(result.message, "unreachable");
  } finally {
    await pool.end();
  }
});
