export const RELAY_MCP_RESOURCE_SCOPES: readonly [
  "tools:read",
  "tools:execute",
  "runs:read",
  "runs:cancel",
  "artifacts:read",
  "artifacts:write",
  "artifacts:share",
  "usage:read",
] = Object.freeze([
  "tools:read",
  "tools:execute",
  "runs:read",
  "runs:cancel",
  "artifacts:read",
  "artifacts:write",
  "artifacts:share",
  "usage:read",
]);

export type RelayMcpResourceScope = (typeof RELAY_MCP_RESOURCE_SCOPES)[number];
