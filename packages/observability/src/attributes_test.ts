import { assertEquals, assertThrows } from "@std/assert";
import { AttributeGuard } from "./attributes.ts";

Deno.test("attribute guard drops prohibited keys and normalizes HTTP values", () => {
  const guard = new AttributeGuard();
  const sanitized = guard.sanitize({
    "http.route": "/runs/550e8400-e29b-41d4-a716-446655440000",
    "http.request.method": "get",
    "http.response.status_class": 503,
    operation: "dispatch",
    "user.id": "user-canary",
    "job.id": "job-canary",
    "url.full": "https://example.test/?token=secret",
    prompt: "prompt-canary",
  });

  assertEquals(sanitized, {
    "http.route": "/__unknown__",
    "http.request.method": "GET",
    "http.response.status_class": "5xx",
    operation: "dispatch",
  });
});

Deno.test("attribute guard omits absent optional values", () => {
  const guard = new AttributeGuard();
  assertEquals(
    guard.sanitize({
      outcome: undefined,
      "http.route": undefined,
      "http.request.method": undefined,
      "http.response.status_class": undefined,
    }),
    {},
  );
});

Deno.test("attribute guard accepts bounded semantic tool versions", () => {
  const guard = new AttributeGuard();
  assertEquals(guard.sanitize({ "tool.version": "1.2.3-beta.1" }), {
    "tool.version": "1.2.3-beta.1",
  });
});

Deno.test("attribute guard has a hard per-key cardinality ceiling", () => {
  const guard = new AttributeGuard({ maxValuesPerKey: 2 });
  assertEquals(
    guard.sanitize({ provider: "provider-a" }).provider,
    "provider-a",
  );
  assertEquals(
    guard.sanitize({ provider: "provider-b" }).provider,
    "provider-b",
  );
  assertEquals(guard.sanitize({ provider: "provider-c" }).provider, "other");
  assertEquals(
    guard.sanitize({ provider: "provider-a" }).provider,
    "provider-a",
  );
});

Deno.test("route cardinality overflow preserves a valid route sentinel", () => {
  const guard = new AttributeGuard({ maxValuesPerKey: 1 });
  assertEquals(guard.sanitize({ "http.route": "/health/live" }), {
    "http.route": "/health/live",
  });
  assertEquals(guard.sanitize({ "http.route": "/version" }), {
    "http.route": "/__unknown__",
  });
});

Deno.test("attribute allow-lists map unapproved catalog values to other", () => {
  const guard = new AttributeGuard({
    allowedValues: {
      provider: ["approved-provider"],
      model: ["approved-model-v1"],
    },
  });
  assertEquals(
    guard.sanitize({
      provider: "unapproved-provider",
      model: "approved-model-v1",
    }),
    {
      provider: "other",
      model: "approved-model-v1",
    },
  );
});

Deno.test("attribute allow-lists reject fixed or invalid controlled values", () => {
  assertThrows(
    () =>
      new AttributeGuard({
        allowedValues: { outcome: ["success"] } as never,
      }),
    TypeError,
    "unsupported controlled attribute key",
  );
  assertThrows(
    () =>
      new AttributeGuard({
        allowedValues: { "http.route": ["/__unknown__"] },
      }),
    TypeError,
    "invalid http.route value",
  );
});
