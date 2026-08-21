import { assertEquals } from "@std/assert";
import { CANONICAL_SQL, migration } from "./0010_queue_counters.ts";
import { sha256Hex } from "./checksum.ts";

Deno.test("0010_queue_counters checksum matches its canonical SQL", async () => {
  assertEquals(await sha256Hex(CANONICAL_SQL), migration.checksumSha256);
});
