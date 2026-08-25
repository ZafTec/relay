import { assertEquals } from "@std/assert";
import { canonicalJson, fingerprint } from "./canonical.ts";

Deno.test("canonical JSON ignores object insertion order", async () => {
  const left = { z: [3, { b: true, a: "x" }], a: 1 };
  const right = { a: 1, z: [3, { a: "x", b: true }] };
  assertEquals(canonicalJson(left), canonicalJson(right));
  assertEquals(await fingerprint(left), await fingerprint(right));
});

Deno.test("canonical JSON uses locale-independent UTF-16 key order", () => {
  assertEquals(canonicalJson({ a: 2, Z: 1 }), '{"Z":1,"a":2}');
});
