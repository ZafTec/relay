import {
  validateWorkspaceActorContext,
  type WorkspaceActorContext,
} from "@relay/application";
import { type Auth, getMembership, type Queryable } from "@relay/auth";
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

/**
 * Builds the production cookie-session resolver. The active organization stored
 * on the session is treated only as context; every resolution checks current
 * membership before returning an authenticated workspace identity.
 */
export function createAuthSessionIdentityResolver(
  auth: Pick<Auth, "api">,
  queryable: Queryable,
): SessionIdentityResolver {
  return async (request) => {
    const current = await auth.api.getSession({ headers: request.headers });
    if (current === null) return { kind: "unauthenticated" };

    const actorUserId = current.user.id;
    const workspaceId = current.session.activeOrganizationId;
    if (typeof workspaceId !== "string" || workspaceId.trim() === "") {
      return { kind: "workspace_unavailable", actorUserId };
    }

    const membershipRole = await getMembership(
      queryable,
      workspaceId,
      actorUserId,
    );
    if (membershipRole === null) {
      return { kind: "workspace_unavailable", actorUserId };
    }

    return {
      kind: "authenticated",
      identity: { workspaceId, actorUserId, membershipRole },
    };
  };
}

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
