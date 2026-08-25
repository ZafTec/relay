import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import {
  generateArtifactId,
  generateShareSecret,
  hashShareSecret,
} from "./ids.ts";

Deno.test("artifact IDs and share secrets are opaque and collision-resistant in shape", () => {
  const first = generateArtifactId("art");
  const second = generateArtifactId("art");
  assertMatch(first, /^art_[0-9a-f]{32}$/);
  assertNotEquals(first, second);

  const secret = generateShareSecret();
  assertMatch(secret, /^[A-Za-z0-9_-]{43}$/);
  assertEquals(secret.includes("="), false);
  assertEquals(secret.includes("://"), false);
});

Deno.test("share secrets are represented durably only by deterministic SHA-256", async () => {
  const secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const first = await hashShareSecret(secret);
  const second = await hashShareSecret(secret);
  assertEquals(first, second);
  assertMatch(first, /^[0-9a-f]{64}$/);
  assertEquals(first.includes(secret), false);
});
