import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { createImmutableObjectKey } from "./keys.ts";

Deno.test("immutable keys are random, opaque, and version-specific", () => {
  const input = {
    artifactId: "art_0123456789abcdef0123456789abcdef",
    artifactVersionId: "aver_fedcba9876543210fedcba9876543210",
  };
  const first = createImmutableObjectKey(input);
  const second = createImmutableObjectKey(input);

  assertNotEquals(first, second);
  assertEquals(
    /^artifacts\/art_[0-9a-f]{32}\/aver_[0-9a-f]{32}\/[0-9a-f]{48}$/
      .test(first),
    true,
  );
  assertEquals(first.includes("filename"), false);
  assertEquals(first.includes("://"), false);
});

Deno.test("immutable key generation rejects caller-controlled path segments", () => {
  assertThrows(
    () =>
      createImmutableObjectKey({
        artifactId: "../../other-workspace",
        artifactVersionId: "aver_fedcba9876543210fedcba9876543210",
      }),
    TypeError,
  );
});
