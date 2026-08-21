import { assertEquals } from "@std/assert";
import { CANONICAL_SQL, migration } from "./0002_personal_workspaces.ts";
import { sha256Hex } from "./checksum.ts";

Deno.test("0002_personal_workspaces checksum matches its canonical SQL", async () => {
  assertEquals(await sha256Hex(CANONICAL_SQL), migration.checksumSha256);
});
