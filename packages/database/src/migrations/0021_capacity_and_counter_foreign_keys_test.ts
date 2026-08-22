import { assertEquals } from "@std/assert";
import {
  CANONICAL_SQL,
  migration,
} from "./0021_capacity_and_counter_foreign_keys.ts";
import { sha256Hex } from "./checksum.ts";

Deno.test(
  "0021_capacity_and_counter_foreign_keys checksum matches its canonical SQL",
  async () => {
    assertEquals(await sha256Hex(CANONICAL_SQL), migration.checksumSha256);
  },
);
