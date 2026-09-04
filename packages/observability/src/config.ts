export interface ObservabilityResourceAttributes {
  readonly "deployment.environment.name": string;
  readonly "relay.build.revision": string;
  readonly "service.instance.id": string;
  readonly "service.namespace": "relay";
  readonly "service.version": string;
}

export type RelayServiceName = "relay-api" | "relay-worker";
export type RelayTraceSampler = "always_on" | "parentbased_traceidratio";

export interface ObservabilityConfig {
  readonly enabled: true;
  readonly protocol: "http/protobuf";
  readonly endpoint: URL;
  readonly serviceName: RelayServiceName;
  readonly resourceAttributes: ObservabilityResourceAttributes;
  readonly propagators: readonly ["tracecontext"];
  readonly consoleMode: "capture";
  readonly metricExportIntervalMs: number;
  readonly sampler: RelayTraceSampler;
  readonly samplerRatio: number | null;
}

const RESOURCE_KEYS = new Set([
  "deployment.environment.name",
  "relay.build.revision",
  "service.instance.id",
  "service.namespace",
  "service.version",
]);
const FORBIDDEN_EXPORTER_OVERRIDES = [
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_TRACES_EXPORTER",
] as const;
const OBSERVABILITY_ENVIRONMENT_VARIABLES = [
  "OTEL_DENO",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  ...FORBIDDEN_EXPORTER_OVERRIDES,
  "OTEL_SERVICE_NAME",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_PROPAGATORS",
  "OTEL_DENO_CONSOLE",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_TRACES_SAMPLER",
  "OTEL_TRACES_SAMPLER_ARG",
] as const;

type ObservabilityEnv = Record<string, string | undefined>;

function readProcessEnvironment(names: readonly string[]): ObservabilityEnv {
  const env: ObservabilityEnv = {};
  for (const name of names) env[name] = Deno.env.get(name);
  return env;
}

function required(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function decodeResourcePart(value: string, name: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(
      `OTEL_RESOURCE_ATTRIBUTES contains invalid encoding for ${name}`,
    );
  }
}

function parseResourceAttributes(
  value: string | undefined,
): ObservabilityResourceAttributes {
  const source = required("OTEL_RESOURCE_ATTRIBUTES", value);
  const parsed = new Map<string, string>();

  for (const entry of source.split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new Error("OTEL_RESOURCE_ATTRIBUTES contains an invalid entry");
    }
    const key = decodeResourcePart(entry.slice(0, separator).trim(), "a key");
    if (!RESOURCE_KEYS.has(key)) {
      throw new Error(
        `OTEL_RESOURCE_ATTRIBUTES contains unsupported key ${key}`,
      );
    }
    if (parsed.has(key)) {
      throw new Error(`OTEL_RESOURCE_ATTRIBUTES contains duplicate key ${key}`);
    }
    const attribute = decodeResourcePart(
      entry.slice(separator + 1).trim(),
      key,
    );
    if (attribute === "") {
      throw new Error(`OTEL_RESOURCE_ATTRIBUTES requires a value for ${key}`);
    }
    parsed.set(key, attribute);
  }

  for (const key of RESOURCE_KEYS) {
    if (!parsed.has(key)) {
      throw new Error(`OTEL_RESOURCE_ATTRIBUTES requires ${key}`);
    }
  }

  const namespace = parsed.get("service.namespace")!;
  if (namespace !== "relay") {
    throw new Error("service.namespace must be relay");
  }
  const environment = parsed.get("deployment.environment.name")!;
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(environment)) {
    throw new Error("deployment.environment.name has an invalid format");
  }
  const version = parsed.get("service.version")!;
  if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(version)) {
    throw new Error("service.version has an invalid format");
  }
  const revision = parsed.get("relay.build.revision")!;
  if (!/^(?:[0-9a-f]{7,64}|development|unknown)$/i.test(revision)) {
    throw new Error("relay.build.revision has an invalid format");
  }
  const instanceId = parsed.get("service.instance.id")!;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(
        instanceId,
      )
  ) {
    throw new Error("service.instance.id must be a per-process UUID");
  }

  return {
    "deployment.environment.name": environment,
    "relay.build.revision": revision,
    "service.instance.id": instanceId,
    "service.namespace": "relay",
    "service.version": version,
  };
}

function parseEndpoint(value: string | undefined): URL {
  const source = required("OTEL_EXPORTER_OTLP_ENDPOINT", value);
  let endpoint: URL;
  try {
    endpoint = new URL(source);
  } catch {
    throw new Error("OTEL_EXPORTER_OTLP_ENDPOINT must be a valid URL");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("OTEL_EXPORTER_OTLP_ENDPOINT must use http:// or https://");
  }
  if (
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error(
      "OTEL_EXPORTER_OTLP_ENDPOINT must not contain credentials, a query, or a fragment",
    );
  }
  if (endpoint.pathname !== "/") {
    throw new Error(
      "OTEL_EXPORTER_OTLP_ENDPOINT must be the Alloy base URL without a signal path",
    );
  }
  return endpoint;
}

function parseInterval(value: string | undefined): number {
  const parsed = value === undefined ? 15_000 : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 300_000) {
    throw new Error(
      "OTEL_METRIC_EXPORT_INTERVAL must be an integer between 1000 and 300000",
    );
  }
  return parsed;
}

function parseSampler(
  env: Record<string, string | undefined>,
): Pick<ObservabilityConfig, "sampler" | "samplerRatio"> {
  const sampler = env.OTEL_TRACES_SAMPLER ?? "always_on";
  if (sampler === "always_on") {
    if (env.OTEL_TRACES_SAMPLER_ARG !== undefined) {
      throw new Error(
        "OTEL_TRACES_SAMPLER_ARG is only valid for ratio sampling",
      );
    }
    return { sampler, samplerRatio: null };
  }
  if (sampler !== "parentbased_traceidratio") {
    throw new Error(
      "OTEL_TRACES_SAMPLER must be always_on or parentbased_traceidratio",
    );
  }
  const ratio = Number(required(
    "OTEL_TRACES_SAMPLER_ARG",
    env.OTEL_TRACES_SAMPLER_ARG,
  ));
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new Error("OTEL_TRACES_SAMPLER_ARG must be between 0 and 1");
  }
  return { sampler, samplerRatio: ratio };
}

/** Strict startup validation for the single-exporter Relay -> Alloy topology. */
export function loadObservabilityConfig(
  env: ObservabilityEnv = readProcessEnvironment(
    OBSERVABILITY_ENVIRONMENT_VARIABLES,
  ),
): ObservabilityConfig {
  if (env.OTEL_DENO !== "true") {
    throw new Error("OTEL_DENO must be true");
  }
  if (
    (env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/protobuf") !== "http/protobuf"
  ) {
    throw new Error("OTEL_EXPORTER_OTLP_PROTOCOL must be http/protobuf");
  }
  for (const key of FORBIDDEN_EXPORTER_OVERRIDES) {
    if (env[key] !== undefined) {
      throw new Error(
        `${key} must be unset; Relay uses credential-free OTLP to one Alloy base endpoint`,
      );
    }
  }

  const serviceName = required("OTEL_SERVICE_NAME", env.OTEL_SERVICE_NAME);
  if (serviceName !== "relay-api" && serviceName !== "relay-worker") {
    throw new Error("OTEL_SERVICE_NAME must be relay-api or relay-worker");
  }
  if (env.OTEL_PROPAGATORS !== "tracecontext") {
    throw new Error("OTEL_PROPAGATORS must be tracecontext");
  }
  if ((env.OTEL_DENO_CONSOLE ?? "capture") !== "capture") {
    throw new Error("OTEL_DENO_CONSOLE must be capture");
  }

  const sampling = parseSampler(env);
  return {
    enabled: true,
    protocol: "http/protobuf",
    endpoint: parseEndpoint(env.OTEL_EXPORTER_OTLP_ENDPOINT),
    serviceName,
    resourceAttributes: parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES),
    propagators: ["tracecontext"],
    consoleMode: "capture",
    metricExportIntervalMs: parseInterval(env.OTEL_METRIC_EXPORT_INTERVAL),
    ...sampling,
  };
}

/** Generate this once in the process launcher, before Deno initializes OTel. */
export function createServiceInstanceId(): string {
  return crypto.randomUUID();
}
