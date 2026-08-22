import { assertEquals } from "@std/assert";
import { CANONICAL_SQL, migration } from "./0015_routing_policies.ts";
import { sha256Hex } from "./checksum.ts";

Deno.test("0015_routing_policies checksum matches its canonical SQL", async () => {
  assertEquals(await sha256Hex(CANONICAL_SQL), migration.checksumSha256);
});
