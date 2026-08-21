import { assertEquals } from "@std/assert";
import { CANONICAL_SQL, migration } from "./0003_system_role_assignments.ts";
import { sha256Hex } from "./checksum.ts";

Deno.test("0003_system_role_assignments checksum matches its canonical SQL", async () => {
  assertEquals(await sha256Hex(CANONICAL_SQL), migration.checksumSha256);
});
