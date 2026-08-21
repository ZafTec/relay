export { createAuth } from "./auth.ts";
export type { Auth } from "./auth.ts";

export { ensurePersonalWorkspace } from "./workspaces.ts";
export type { BetterAuthAdapter } from "./workspaces.ts";

export { canRemoveMember, getMembership } from "./authorization.ts";
export type { WorkspaceRole } from "./authorization.ts";

export {
  grantSuperadmin,
  isSuperadmin,
  revokeSuperadmin,
} from "./system-roles.ts";
export type { SystemRoleAuditSink, SystemRoleGrant } from "./system-roles.ts";
