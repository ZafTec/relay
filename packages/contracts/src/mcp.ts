export const RELAY_MCP_WORKSPACE_SCOPES: readonly [
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
] = Object.freeze(
  [
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
  ] as const,
);

/** Platform access is separately consented and never part of a default challenge. */
export const RELAY_MCP_ADMIN_SCOPES: readonly [
  "admin:allowances:read",
  "admin:allowances:write",
  "admin:capacity:read",
  "admin:capacity:write",
  "admin:superadmins:read",
  "admin:superadmins:write",
  "admin:changelog:read",
  "admin:changelog:write",
  "admin:oauth:read",
  "admin:oauth:write",
] = Object.freeze(
  [
    "admin:allowances:read",
    "admin:allowances:write",
    "admin:capacity:read",
    "admin:capacity:write",
    "admin:superadmins:read",
    "admin:superadmins:write",
    "admin:changelog:read",
    "admin:changelog:write",
    "admin:oauth:read",
    "admin:oauth:write",
  ] as const,
);

export const RELAY_MCP_RESOURCE_SCOPES: readonly [
  ...typeof RELAY_MCP_WORKSPACE_SCOPES,
  ...typeof RELAY_MCP_ADMIN_SCOPES,
] = Object.freeze(
  [
    ...RELAY_MCP_WORKSPACE_SCOPES,
    ...RELAY_MCP_ADMIN_SCOPES,
  ] as const,
);

export type RelayMcpResourceScope = (typeof RELAY_MCP_RESOURCE_SCOPES)[number];
