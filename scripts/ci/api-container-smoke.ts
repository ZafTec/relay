#!/usr/bin/env -S deno run --allow-env --allow-net

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} did not return a JSON object`);
  }
  return value as Record<string, unknown>;
}

async function getJson(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(
    new URL(path, requiredEnvironment("RELAY_API_BASE_URL")),
  );
  if (response.status !== 200) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(`${path} did not return JSON`);
  }
  return asRecord(await response.json(), path);
}

const expectedVersion = requiredEnvironment("RELAY_EXPECTED_VERSION");
const expectedRevision = requiredEnvironment("RELAY_EXPECTED_REVISION");
const expectedIssuer = requiredEnvironment("RELAY_EXPECTED_ISSUER");
const expectedMcpResource = requiredEnvironment("RELAY_EXPECTED_MCP_RESOURCE");

const liveness = await getJson("/health/live");
const liveBuild = asRecord(liveness.build, "/health/live build");
if (
  liveness.service !== "api" ||
  liveness.status !== "ok" ||
  liveBuild.version !== expectedVersion ||
  liveBuild.revision !== expectedRevision
) {
  throw new Error("/health/live returned unexpected build or status data");
}

const readiness = await getJson("/health/ready");
const readyBuild = asRecord(readiness.build, "/health/ready build");
if (
  readiness.service !== "api" ||
  readiness.status !== "ok" ||
  readyBuild.version !== expectedVersion ||
  readyBuild.revision !== expectedRevision ||
  !Array.isArray(readiness.checks)
) {
  throw new Error("/health/ready returned unexpected build or status data");
}
const checks = readiness.checks.map((value, index) =>
  asRecord(value, `/health/ready checks[${index}]`)
);
for (const name of ["database", "migrations"]) {
  const check = checks.find((candidate) => candidate.name === name);
  if (check?.status !== "ok") {
    throw new Error(`/health/ready did not report ${name} as healthy`);
  }
}

const version = await getJson("/version");
if (
  version.version !== expectedVersion ||
  version.revision !== expectedRevision
) {
  throw new Error("/version did not match the image build metadata");
}

const authorizationMetadata = await getJson(
  "/.well-known/oauth-authorization-server/api/auth",
);
if (authorizationMetadata.issuer !== expectedIssuer) {
  throw new Error("OAuth authorization metadata did not use the public issuer");
}

const resourceMetadata = await getJson(
  "/.well-known/oauth-protected-resource/mcp",
);
if (resourceMetadata.resource !== expectedMcpResource) {
  throw new Error("MCP resource metadata did not use the public resource URL");
}
if (
  !Array.isArray(resourceMetadata.authorization_servers) ||
  !resourceMetadata.authorization_servers.includes(expectedIssuer)
) {
  throw new Error(
    "MCP resource metadata did not advertise the authorization server",
  );
}

console.log("Backend container smoke checks passed.");
