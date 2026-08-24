import { assertEquals } from "@std/assert";
import {
  REDACTED_VALUE,
  sanitizeRouteTemplate,
  sanitizeTelemetryText,
  sanitizeVersion,
  UNKNOWN_ROUTE,
} from "./redaction.ts";

Deno.test("telemetry text redacts sensitive canaries", () => {
  const canaries = [
    "Authorization: Bearer bearer-canary-123",
    "token=eyJhbGciOiJIUzI1NiJ9.c2VjcmV0.signature",
    "callback=https://relay.example/callback?code=oauth-code-canary&state=state-canary",
    "signed_url=https://s3.example/private/object?X-Amz-Signature=signed-canary",
    "prompt=draw the private canary",
    "object_key=workspace/private/object-canary.png",
    "sql_query=select * from users where email='sql-canary@example.com'",
    "cookie=session=secret-cookie-canary",
    "provider_payload={result:provider-canary}",
  ];

  for (const canary of canaries) {
    assertEquals(sanitizeTelemetryText(canary), REDACTED_VALUE);
  }
});

Deno.test("telemetry text remains bounded and single-line", () => {
  const sanitized = sanitizeTelemetryText(`safe\n${"x".repeat(1_000)}`, 64);
  assertEquals(sanitized.includes("\n"), false);
  assertEquals(sanitized.length, 64);
  assertEquals(sanitized.endsWith("[truncated]"), true);
});

Deno.test("version sanitizer accepts semantic versions and rejects URLs", () => {
  assertEquals(sanitizeVersion("1.2.3-beta.1+build"), "1.2.3-beta.1+build");
  assertEquals(sanitizeVersion("https://example.test/version"), null);
});

Deno.test("route sanitizer accepts templates and rejects raw identifiers", () => {
  assertEquals(
    sanitizeRouteTemplate("/api/v1/runs/:runId/artifacts/{artifactId}"),
    "/api/v1/runs/:runId/artifacts/{artifactId}",
  );
  assertEquals(
    sanitizeRouteTemplate("/runs/550e8400-e29b-41d4-a716-446655440000"),
    UNKNOWN_ROUTE,
  );
  assertEquals(sanitizeRouteTemplate("/runs/12345"), UNKNOWN_ROUTE);
  assertEquals(
    sanitizeRouteTemplate("/oauth/callback?code=oauth-code-canary"),
    UNKNOWN_ROUTE,
  );
  assertEquals(
    sanitizeRouteTemplate("/.well-known/oauth-protected-resource/mcp"),
    "/.well-known/oauth-protected-resource/mcp",
  );
});
