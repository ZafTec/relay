export const RELAY_MCP_RESOURCE_SCOPES: readonly [
  "tools:read",
  "tools:execute",
  "runs:read",
  "runs:cancel",
  "artifacts:read",
  "artifacts:write",
  "artifacts:share",
  "usage:read",
  "notifications:read",
  "notifications:write",
] = Object.freeze([
  "tools:read",
  "tools:execute",
  "runs:read",
  "runs:cancel",
  "artifacts:read",
  "artifacts:write",
  "artifacts:share",
  "usage:read",
  "notifications:read",
  "notifications:write",
]);

export type RelayMcpResourceScope = (typeof RELAY_MCP_RESOURCE_SCOPES)[number];
