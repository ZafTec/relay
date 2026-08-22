import { assertEquals } from "@std/assert";
import { CANONICAL_SQL, migration } from "./0017_routing_decisions.ts";
import { sha256Hex } from "./checksum.ts";

Deno.test("0017_routing_decisions checksum matches its canonical SQL", async () => {
  assertEquals(await sha256Hex(CANONICAL_SQL), migration.checksumSha256);
});
