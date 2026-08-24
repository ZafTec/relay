import {
  validateWorkspaceActorContext,
  type WorkspaceActorContext,
} from "@relay/application";
import { authenticationRequired, notFound } from "./errors.ts";

export type WorkspaceMembershipRole = "owner" | "admin" | "member";

export interface ActiveWorkspaceIdentity extends WorkspaceActorContext {
  /** Evidence that the resolver performed a current membership lookup. */
  readonly membershipRole: WorkspaceMembershipRole;
}

export type SessionIdentityResolution =
  | {
    readonly kind: "authenticated";
    readonly identity: ActiveWorkspaceIdentity;
  }
  | { readonly kind: "unauthenticated" }
  | {
    /** The cookie session is valid, but its active workspace is absent or stale. */
    readonly kind: "workspace_unavailable";
    readonly actorUserId: string;
  };

/**
 * Resolves the cookie session, active workspace, and current membership.
 * Implementations must not trust the session's active workspace without a fresh
 * membership lookup.
 */
export type SessionIdentityResolver = (
  request: Request,
) => Promise<SessionIdentityResolution>;

const MEMBERSHIP_ROLES = new Set<WorkspaceMembershipRole>([
  "owner",
  "admin",
  "member",
]);

function validateActorUserId(actorUserId: string): string {
  if (
    typeof actorUserId !== "string" || actorUserId.length === 0 ||
    actorUserId.length > 255 || actorUserId.trim() !== actorUserId ||
    /[\r\n\0]/.test(actorUserId)
  ) {
    throw new TypeError("identity resolver returned an invalid actor user ID");
  }
  return actorUserId;
}

function validateIdentity(
  identity: ActiveWorkspaceIdentity,
): ActiveWorkspaceIdentity {
  const context = validateWorkspaceActorContext(identity);
  if (!MEMBERSHIP_ROLES.has(identity.membershipRole)) {
    throw new TypeError(
      "identity resolver returned an invalid membership role",
    );
  }
  return { ...context, membershipRole: identity.membershipRole };
}

export async function requireWorkspaceIdentity(
  resolver: SessionIdentityResolver,
  request: Request,
): Promise<WorkspaceActorContext> {
  const resolution = await resolver(request);
  switch (resolution.kind) {
    case "unauthenticated":
      throw authenticationRequired();
    case "workspace_unavailable":
      validateActorUserId(resolution.actorUserId);
      throw notFound();
    case "authenticated": {
      const identity = validateIdentity(resolution.identity);
      return {
        workspaceId: identity.workspaceId,
        actorUserId: identity.actorUserId,
      };
    }
  }
}

export async function optionalActorUserId(
  resolver: SessionIdentityResolver,
  request: Request,
): Promise<string | undefined> {
  const resolution = await resolver(request);
  switch (resolution.kind) {
    case "unauthenticated":
      return undefined;
    case "workspace_unavailable":
      return validateActorUserId(resolution.actorUserId);
    case "authenticated":
      return validateIdentity(resolution.identity).actorUserId;
  }
}

export async function identityIsStillCurrent(
  resolver: SessionIdentityResolver,
  request: Request,
  expected: WorkspaceActorContext,
): Promise<boolean> {
  const resolution = await resolver(request);
  if (resolution.kind !== "authenticated") return false;
  const identity = validateIdentity(resolution.identity);
  return identity.actorUserId === expected.actorUserId &&
    identity.workspaceId === expected.workspaceId;
}
