import { assertEquals } from "@std/assert";
import {
  CANONICAL_SQL as oauthSql,
  migration as oauthMigration,
} from "./0003_oauth_client_audit.ts";
import {
  CANONICAL_SQL as imageSql,
  migration as imageMigration,
} from "./0004_image_generation_and_editing.ts";
import { sha256Hex } from "./checksum.ts";

Deno.test("OAuth and image migrations retain their canonical checksums", async () => {
  assertEquals(await sha256Hex(oauthSql), oauthMigration.checksumSha256);
  assertEquals(await sha256Hex(imageSql), imageMigration.checksumSha256);
});
