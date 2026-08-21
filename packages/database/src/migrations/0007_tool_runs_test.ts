import { assertEquals } from "@std/assert";
import { CANONICAL_SQL, migration } from "./0007_tool_runs.ts";
import { sha256Hex } from "./checksum.ts";

Deno.test("0007_tool_runs checksum matches its canonical SQL", async () => {
  assertEquals(await sha256Hex(CANONICAL_SQL), migration.checksumSha256);
});
