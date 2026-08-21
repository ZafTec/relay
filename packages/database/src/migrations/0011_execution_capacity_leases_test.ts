import { assertEquals } from "@std/assert";
import { CANONICAL_SQL, migration } from "./0011_execution_capacity_leases.ts";
import { sha256Hex } from "./checksum.ts";

Deno.test("0011_execution_capacity_leases checksum matches its canonical SQL", async () => {
  assertEquals(await sha256Hex(CANONICAL_SQL), migration.checksumSha256);
});
