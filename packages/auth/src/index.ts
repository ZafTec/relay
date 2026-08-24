export { createAuth } from "./auth.ts";
export type { Auth, McpRequestHandler, ProtectMcpOptions } from "./auth.ts";
export {
  authorizeMcpAccessTokenClaims,
  parseMcpAccessTokenClaims,
  RELAY_AUTHORIZATION_SCOPES,
  RELAY_MCP_RESOURCE_SCOPES,
  RELAY_OAUTH_SCOPES,
  RELAY_WORKSPACE_ID_CLAIM,
  relayMcpResource,
  requireMcpScopes,
} from "./oauth.ts";
export type { AuthorizedMcpPrincipal } from "./oauth.ts";

export {
  ensurePersonalWorkspace,
  personalWorkspaceSlug,
} from "./workspaces.ts";

export { canRemoveMember, getMembership } from "./authorization.ts";
export type { Queryable, WorkspaceRole } from "./authorization.ts";

export { parseTrustedProxyCidrs } from "./proxy.ts";
export type { AuthConnectionInfo } from "./proxy.ts";

export {
  bootstrapSuperadmin,
  grantSuperadmin,
  isSuperadmin,
  revokeSuperadmin,
  SystemRoleIdempotencyConflictError,
} from "./system-roles.ts";
export type {
  BootstrapSuperadminRequest,
  BootstrapSuperadminResult,
  SuperadminMutationRequest,
  SuperadminMutationResult,
  SuperadminOperator,
  SystemRoleGrant,
} from "./system-roles.ts";
