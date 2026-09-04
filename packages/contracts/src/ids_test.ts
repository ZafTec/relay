import { assert, assertEquals, assertMatch } from "@std/assert";
import { generatePublicId, ID_PREFIXES } from "./ids.ts";

Deno.test("generatePublicId produces a prefix_hex id, not a UUID", () => {
  const id = generatePublicId(ID_PREFIXES.run);
  assertMatch(id, /^run_[0-9a-f]{32}$/);
});

Deno.test("generatePublicId is not deterministic across calls", () => {
  const first = generatePublicId(ID_PREFIXES.run);
  const second = generatePublicId(ID_PREFIXES.run);
  assert(first !== second);
});

Deno.test("generatePublicId uses the given prefix verbatim", () => {
  const id = generatePublicId(ID_PREFIXES.artifact);
  assertEquals(id.startsWith("art_"), true);
});
