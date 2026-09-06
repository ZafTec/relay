import { assertEquals } from "@std/assert";
import { CANONICAL_SQL, migration } from "./0002_allowance_management.ts";
import { sha256Hex } from "./checksum.ts";

Deno.test("0002 allowance migration checksum matches canonical SQL", async () => {
  assertEquals(await sha256Hex(CANONICAL_SQL), migration.checksumSha256);
});
