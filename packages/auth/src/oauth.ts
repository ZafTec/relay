import type { McpOptions } from "@better-auth/mcp";
import { APIError } from "better-auth/api";
import { getMembership, type Queryable } from "./authorization.ts";

export const RELAY_AUTHORIZATION_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
] as const;

export const RELAY_MCP_RESOURCE_SCOPES = [
  "tools:read",
  "tools:execute",
  "runs:read",
  "runs:cancel",
  "artifacts:read",
  "artifacts:write",
  "artifacts:share",
  "usage:read",
] as const;

export const RELAY_OAUTH_SCOPES = [
  ...RELAY_AUTHORIZATION_SCOPES,
  ...RELAY_MCP_RESOURCE_SCOPES,
] as const;

export const RELAY_WORKSPACE_ID_CLAIM =
  "https://relay.zaftech.co/claims/workspace_id";

const RELAY_MCP_RESOURCE_SCOPE_SET: ReadonlySet<string> = new Set(
  RELAY_MCP_RESOURCE_SCOPES,
);

interface ProviderUserInfo {
  readonly user: {
    readonly email?: string | null;
    readonly emailVerified?: boolean;
  };
}

/**
 * Wraps a provider's real user-info resolver and refuses the callback unless
 * that callback's current provider response contains a usable verified email.
 * This deliberately runs before Better Auth consults a persisted user, whose
 * historical `emailVerified` value must not satisfy a later OAuth callback.
 */
export function requireCurrentVerifiedEmail<
  Args extends readonly unknown[],
  Result extends ProviderUserInfo | null,
>(
  getUserInfo: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args: Args): Promise<Result> => {
    const result = await getUserInfo(...args);
    if (
      result === null || result.user.emailVerified !== true ||
      typeof result.user.email !== "string" || result.user.email.trim() === ""
    ) {
      return null as Result;
    }
    return result;
  };
}

export function relayMcpResource(baseUrl: URL): string {
  return new URL("/mcp", baseUrl).toString();
}

function requestsRelayResource(scopes: readonly string[]): boolean {
  return scopes.some((scope) => RELAY_MCP_RESOURCE_SCOPE_SET.has(scope));
}

function invalidWorkspaceContext(description: string): APIError {
  return new APIError("BAD_REQUEST", {
    error: "set_organization",
    error_description: description,
  });
}

async function requireCurrentWorkspace(
  queryable: Queryable,
  userIdValue: unknown,
  workspaceIdValue: unknown,
): Promise<string> {
  const userId = typeof userIdValue === "string" && userIdValue.trim() !== ""
    ? userIdValue
    : undefined;
  const workspaceId = typeof workspaceIdValue === "string" &&
      workspaceIdValue.trim() !== ""
    ? workspaceIdValue
    : undefined;

  if (!userId || !workspaceId) {
    throw invalidWorkspaceContext(
      "An authenticated user and active workspace are required.",
    );
  }
  if (await getMembership(queryable, workspaceId, userId) === null) {
    throw invalidWorkspaceContext(
      "The active workspace is no longer available to this user.",
    );
  }
  return workspaceId;
}

/** Builds the MCP OAuth policy shared by production auth and focused tests. */
export function createMcpOAuthOptions(
  queryable: Queryable,
  baseUrl: URL,
): McpOptions {
  const resource = relayMcpResource(baseUrl);

  return {
    loginPage: "/sign-in",
    consentPage: "/oauth/consent",
    resource,
    scopes: [...RELAY_OAUTH_SCOPES],
    resources: [{
      identifier: resource,
      allowedScopes: [...RELAY_MCP_RESOURCE_SCOPES],
    }],
    enforcePerClientResources: true,
    clientRegistrationDefaultResources: [resource],
    clientRegistrationAllowedResources: [],
    grantTypes: ["authorization_code", "refresh_token"],
    allowDynamicClientRegistration: false,
    allowUnauthenticatedClientRegistration: false,
    refreshTokenReuseInterval: 30,
    postLogin: {
      page: "/oauth/workspace",
      shouldRedirect: ({ scopes }) => requestsRelayResource(scopes),
      consentReferenceId: async ({ user, session, scopes }) => {
        if (!requestsRelayResource(scopes)) return undefined;
        return await requireCurrentWorkspace(
          queryable,
          user.id,
          session.activeOrganizationId,
        );
      },
    },
    customAccessTokenClaims: async (
      { user, referenceId, resources, scopes },
    ) => {
      if (
        resources?.includes(resource) !== true || !requestsRelayResource(scopes)
      ) {
        return {};
      }
      const workspaceId = await requireCurrentWorkspace(
        queryable,
        user?.id,
        referenceId,
      );
      return { [RELAY_WORKSPACE_ID_CLAIM]: workspaceId };
    },
  };
}
