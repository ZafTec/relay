import { assertEquals, assertThrows } from "@std/assert";
import {
  ArtifactInputError,
  hasRawUrl,
  serializeDurableArray,
  serializeDurableObject,
  validateDisplayName,
  validateErrorCode,
  validateMediaKind,
  validateMimeType,
  validateNonNegativeInteger,
  validatePositiveInteger,
} from "./validation.ts";

Deno.test("artifact scalar validation normalizes safe values", () => {
  assertEquals(validateDisplayName("  Result image  "), "Result image");
  assertEquals(validateMediaKind(" Image.PNG "), "image.png");
  assertEquals(
    validateMimeType(" Image/PNG; Charset=UTF-8 "),
    "image/png; charset=utf-8",
  );
  assertEquals(validateErrorCode(" Provider.Timeout "), "provider.timeout");
  assertEquals(validateNonNegativeInteger(0, "ordinal"), 0);
  assertEquals(validatePositiveInteger(12, "width"), 12);
  assertEquals(validatePositiveInteger(undefined, "width"), null);
});

Deno.test("artifact scalar validation rejects URLs, controls, and invalid counts", () => {
  assertThrows(
    () => validateDisplayName("https://signed.example.test/file"),
    ArtifactInputError,
    "non-URL",
  );
  assertThrows(
    () => validateDisplayName("unsafe\u0007name"),
    ArtifactInputError,
  );
  assertThrows(() => validateMimeType("not-a-mime"), ArtifactInputError);
  assertThrows(
    () => validateMimeType("text/plain\r\nx: y"),
    ArtifactInputError,
  );
  assertThrows(
    () => validateNonNegativeInteger(-1, "ordinal"),
    ArtifactInputError,
  );
  assertThrows(() => validatePositiveInteger(0, "width"), ArtifactInputError);
});

Deno.test("durable JSON accepts plain JSON and rejects raw or signed URLs", () => {
  assertEquals(
    serializeDurableObject({ model: "v1", nested: [1, true, null] }),
    '{"model":"v1","nested":[1,true,null]}',
  );
  assertEquals(serializeDurableArray([{ code: "safe" }]), '[{"code":"safe"}]');
  for (
    const value of [
      { source: "https://provider.example/output" },
      { nested: [{ signed: "s3://bucket/key" }] },
      { "https://bad-key.example": "value" },
    ]
  ) {
    assertThrows(
      () => serializeDurableObject(value),
      ArtifactInputError,
      "raw URL",
    );
    assertEquals(hasRawUrl(value), true);
  }
});

Deno.test("durable JSON rejects cycles, class instances, bigint, and excess depth", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assertThrows(
    () => serializeDurableObject(cyclic),
    ArtifactInputError,
    "cycles",
  );
  assertThrows(
    () => serializeDurableObject({ createdAt: new Date() }),
    ArtifactInputError,
    "JSON objects",
  );
  assertThrows(
    () => serializeDurableObject({ amount: 1n }),
    ArtifactInputError,
    "JSON-compatible",
  );

  let deep: Record<string, unknown> = {};
  const root = deep;
  for (let index = 0; index < 14; index++) {
    const next: Record<string, unknown> = {};
    deep.next = next;
    deep = next;
  }
  assertThrows(
    () => serializeDurableObject(root),
    ArtifactInputError,
    "complex",
  );
});
