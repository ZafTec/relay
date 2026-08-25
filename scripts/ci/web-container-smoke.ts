#!/usr/bin/env -S deno run --allow-env --allow-net

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

const baseUrl = new URL(requiredEnvironment("RELAY_WEB_BASE_URL"));

async function request(path: string): Promise<Response> {
  return await fetch(new URL(path, baseUrl), { redirect: "manual" });
}

const health = await request("/healthz");
if (health.status !== 200 || (await health.text()).trim() !== "ok") {
  throw new Error("Web health endpoint did not return the expected response");
}

const index = await request("/");
const indexBody = await index.text();
if (
  index.status !== 200 ||
  !(index.headers.get("content-type") ?? "").includes("text/html") ||
  !indexBody.includes('<div id="root"></div>')
) {
  throw new Error("Web root did not return the built application document");
}

const assetPath = /(?:src|href)="(\/assets\/[^"]+)"/.exec(indexBody)?.[1];
if (assetPath === undefined) {
  throw new Error("Web root did not reference a hashed build asset");
}
const asset = await request(assetPath);
if (
  asset.status !== 200 ||
  (asset.headers.get("content-type") ?? "").includes("text/html")
) {
  throw new Error("A built web asset was unavailable or fell back to HTML");
}

const spa = await request("/dashboard/runs/test-route");
if (spa.status !== 200 || (await spa.text()) !== indexBody) {
  throw new Error(
    "The web image did not serve the SPA fallback for a browser route",
  );
}

for (
  const path of [
    "/api/v1",
    "/mcp",
    "/health/live",
    "/version",
    "/.well-known/oauth-authorization-server",
    "/s/test-token",
    "/assets/missing.js",
  ]
) {
  const response = await request(path);
  const body = await response.text();
  if (response.status !== 404 || body.includes('<div id="root"></div>')) {
    throw new Error(`${path} incorrectly fell through to the SPA document`);
  }
}

console.log("Web container smoke checks passed.");
