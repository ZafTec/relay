import { assertEquals } from "@std/assert";
import type { HandlerRegistry } from "@relay/catalog";
import type { DatabasePool } from "@relay/database";
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
