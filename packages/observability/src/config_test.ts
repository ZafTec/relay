import { assertEquals, assertMatch, assertThrows } from "@std/assert";
import { createServiceInstanceId, loadObservabilityConfig } from "./config.ts";

const validEnvironment = {
  OTEL_DENO: "true",
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://alloy:4318",
  OTEL_SERVICE_NAME: "relay-api",
  OTEL_RESOURCE_ATTRIBUTES:
    "service.namespace=relay,deployment.environment.name=production,service.version=1.2.3,relay.build.revision=5a37000,service.instance.id=550e8400-e29b-41d4-a716-446655440000",
  OTEL_PROPAGATORS: "tracecontext",
  OTEL_DENO_CONSOLE: "capture",
  OTEL_METRIC_EXPORT_INTERVAL: "15000",
  OTEL_TRACES_SAMPLER: "always_on",
};

function withStubbedProcessEnvironment<T>(
  environment: Record<string, string | undefined>,
  callback: (reads: readonly string[]) => T,
): T {
  const originalGet = Deno.env.get;
  const originalToObject = Deno.env.toObject;
  const reads: string[] = [];
  Deno.env.get = (name) => {
    reads.push(name);
    return environment[name];
  };
  Deno.env.toObject = () => {
    throw new Error("loaders must not enumerate the process environment");
  };
  try {
    return callback(reads);
  } finally {
    Deno.env.get = originalGet;
    Deno.env.toObject = originalToObject;
  }
}

Deno.test("observability defaults read only allowlisted OTel variables", () => {
  withStubbedProcessEnvironment(
    {
      ...validEnvironment,
      AZURE_API_KEY: "unrelated-worker-secret",
      BETTER_AUTH_SECRET: "unrelated-api-secret",
      SHARE_TOKEN_KEYS: "unrelated-api-secret",
    },
    (reads) => {
      assertEquals(loadObservabilityConfig().serviceName, "relay-api");
      assertEquals(reads.length > 0, true);
      assertEquals(reads.every((name) => name.startsWith("OTEL_")), true);
      assertEquals(reads.includes("AZURE_API_KEY"), false);
      assertEquals(reads.includes("BETTER_AUTH_SECRET"), false);
      assertEquals(reads.includes("SHARE_TOKEN_KEYS"), false);
    },
  );
});

Deno.test("observability config validates the single Alloy endpoint", () => {
  const config = loadObservabilityConfig(validEnvironment);
  assertEquals(config.endpoint.toString(), "http://alloy:4318/");
  assertEquals(config.serviceName, "relay-api");
  assertEquals(config.propagators, ["tracecontext"]);
  assertEquals(config.resourceAttributes["service.namespace"], "relay");
});

Deno.test("observability config rejects split signal exporters", () => {
  assertThrows(
    () =>
      loadObservabilityConfig({
        ...validEnvironment,
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://tempo:4318/v1/traces",
      }),
    Error,
    "must be unset",
  );
});

Deno.test("observability config rejects exporter headers and split exporters", () => {
  for (
    const key of [
      "OTEL_EXPORTER_OTLP_HEADERS",
      "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
      "OTEL_LOGS_EXPORTER",
    ]
  ) {
    assertThrows(
      () => loadObservabilityConfig({ ...validEnvironment, [key]: "secret" }),
      Error,
      "must be unset",
    );
  }
});

Deno.test("observability config rejects baggage and credential-bearing endpoints", () => {
  assertThrows(
    () =>
      loadObservabilityConfig({
        ...validEnvironment,
        OTEL_PROPAGATORS: "tracecontext,baggage",
      }),
    Error,
    "tracecontext",
  );

  const secret = "collector-password-canary";
  try {
    loadObservabilityConfig({
      ...validEnvironment,
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://relay:${secret}@alloy:4318`,
    });
    throw new Error("expected config validation to fail");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assertEquals(message.includes(secret), false);
  }
});

Deno.test("observability config validates parent-based ratio sampling", () => {
  const config = loadObservabilityConfig({
    ...validEnvironment,
    OTEL_TRACES_SAMPLER: "parentbased_traceidratio",
    OTEL_TRACES_SAMPLER_ARG: "0.25",
  });
  assertEquals(config.samplerRatio, 0.25);
  assertThrows(
    () =>
      loadObservabilityConfig({
        ...validEnvironment,
        OTEL_TRACES_SAMPLER: "parentbased_traceidratio",
        OTEL_TRACES_SAMPLER_ARG: "2",
      }),
    Error,
    "between 0 and 1",
  );
});

Deno.test("service instance helper returns a UUID", () => {
  assertMatch(
    createServiceInstanceId(),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});
