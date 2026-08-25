import { assertEquals } from "@std/assert";
import {
  jitteredBackoffMs,
  MAX_SANITIZED_ERROR_LENGTH,
  sanitizeError,
} from "./safety.ts";

Deno.test("sanitizeError removes credentials and bounds persisted text", () => {
  const value = sanitizeError(
    new Error(
      `request https://user:password@example.test failed Authorization: Bearer abc.def.ghi token=top-secret ${
        "x".repeat(1_000)
      }`,
    ),
  );
  assertEquals(value.includes("password"), false);
  assertEquals(value.includes("top-secret"), false);
  assertEquals(value.includes("abc.def.ghi"), false);
  assertEquals(value.length <= MAX_SANITIZED_ERROR_LENGTH, true);
});

Deno.test("jitteredBackoffMs is exponential, bounded, and deterministic under an injected RNG", () => {
  const options = { baseDelayMs: 100, maxDelayMs: 500, jitterRatio: 0.2 };
  assertEquals(jitteredBackoffMs(1, options, () => 0), 80);
  assertEquals(jitteredBackoffMs(2, options, () => 0.5), 200);
  assertEquals(jitteredBackoffMs(20, options, () => 1), 500);
});
