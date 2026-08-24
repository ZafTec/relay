import { assertEquals } from "@std/assert";
import { normalizeError } from "./errors.ts";

Deno.test("error normalization never returns raw message or stack", () => {
  const canary = "Bearer raw-error-canary";
  const error = new Error(canary);
  error.stack = `Error: ${canary}\n at private/path.ts:1:1`;

  const normalized = normalizeError(error);
  assertEquals(normalized, {
    type: "internal",
    message: "Operation failed",
  });
  assertEquals(JSON.stringify(normalized).includes(canary), false);
});

Deno.test("error normalization uses a fixed bounded taxonomy", () => {
  const timeout = new Error("private provider detail");
  timeout.name = "TimeoutError";
  assertEquals(normalizeError(timeout), {
    type: "timeout",
    message: "Operation timed out",
  });
  assertEquals(normalizeError("thrown string", { type: "dependency" }), {
    type: "dependency",
    message: "Dependency operation failed",
  });
});

Deno.test("invalid caller-selected error types are never exported", () => {
  assertEquals(
    normalizeError(new Error("private"), {
      type: "Bearer secret-canary" as never,
    }),
    { type: "internal", message: "Operation failed" },
  );
});

Deno.test("hostile thrown values normalize safely", () => {
  const hostile = new Proxy({}, {
    get() {
      throw new Error("proxy canary");
    },
  });
  assertEquals(normalizeError(hostile), {
    type: "internal",
    message: "Operation failed",
  });
});
