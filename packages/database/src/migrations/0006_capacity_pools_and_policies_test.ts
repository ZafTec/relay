import { assertEquals } from "@std/assert";
import {
  CANONICAL_SQL,
  migration,
} from "./0006_capacity_pools_and_policies.ts";
import { sha256Hex } from "./checksum.ts";

Deno.test("0006_capacity_pools_and_policies checksum matches its canonical SQL", async () => {
  assertEquals(await sha256Hex(CANONICAL_SQL), migration.checksumSha256);
});
