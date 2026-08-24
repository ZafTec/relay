import assert from "node:assert/strict";
import {
  canonicalJson,
  createMutationArtifacts,
  sha256Hex,
} from "../src/crypto.ts";

Deno.test("canonical JSON ignores object insertion order but preserves arrays", () => {
  assert.equal(
    canonicalJson({ z: 1, nested: { b: true, a: null }, a: [2, 1] }),
    canonicalJson({ a: [2, 1], nested: { a: null, b: true }, z: 1 }),
  );
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

Deno.test("governance idempotency artifacts are deterministic and one-way", async () => {
  const rawKey = "release-request-0001";
  const left = await createMutationArtifacts("changelog.create", rawKey, {
    title: "Release",
    version: "0.4.0",
  });
  const right = await createMutationArtifacts("changelog.create", rawKey, {
    version: "0.4.0",
    title: "Release",
  });

  assert.deepEqual(left, right);
  assert.match(left.keyHash, /^[0-9a-f]{64}$/);
  assert.match(left.requestFingerprint, /^[0-9a-f]{64}$/);
  assert.notEqual(left.keyHash, rawKey);
  assert.equal(await sha256Hex("relay"), await sha256Hex("relay"));
});

Deno.test("governance idempotency rejects weak or credential-shaped keys", async () => {
  for (const key of ["short", "Bearer secret-token", "x".repeat(129)]) {
    await assert.rejects(
      () => createMutationArtifacts("changelog.create", key, {}),
      /16-128 URL-safe characters/,
    );
  }
});
