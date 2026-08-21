import { assertEquals } from "@std/assert";
import { CANONICAL_SQL, migration } from "./0005_audit_events.ts";
import { sha256Hex } from "./checksum.ts";

Deno.test("0005_audit_events checksum matches its canonical SQL", async () => {
  assertEquals(await sha256Hex(CANONICAL_SQL), migration.checksumSha256);
});
