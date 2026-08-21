import { assertEquals } from "@std/assert";
import { CANONICAL_SQL, migration } from "./0008_idempotency_records.ts";
import { sha256Hex } from "./checksum.ts";

Deno.test("0008_idempotency_records checksum matches its canonical SQL", async () => {
  assertEquals(await sha256Hex(CANONICAL_SQL), migration.checksumSha256);
});
