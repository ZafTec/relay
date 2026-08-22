import { assertEquals } from "@std/assert";
import { CANONICAL_SQL, migration } from "./0020_member_uniqueness.ts";
import { sha256Hex } from "./checksum.ts";

Deno.test("0020_member_uniqueness checksum matches its canonical SQL", async () => {
  assertEquals(await sha256Hex(CANONICAL_SQL), migration.checksumSha256);
});
