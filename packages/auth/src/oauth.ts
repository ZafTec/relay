import type { McpOptions } from "@better-auth/mcp";
import { APIError } from "better-auth/api";
import { isSuperadmin } from "./system-roles.ts";
import { createInsufficientScopeError } from "better-auth/oauth2";
import { RELAY_MCP_RESOURCE_SCOPES } from "@relay/contracts";
import { getMembership, type Queryable } from "./authorization.ts";

export { RELAY_MCP_RESOURCE_SCOPES } from "@relay/contracts";

export const RELAY_AUTHORIZATION_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
] as const;

export const RELAY_OAUTH_SCOPES = [
  ...RELAY_AUTHORIZATION_SCOPES,
  ...RELAY_MCP_RESOURCE_SCOPES,
] as const;

export const RELAY_WORKSPACE_ID_CLAIM = "urn:relay:workspace_id";

export interface AuthorizedMcpPrincipal {
  readonly actorUserId: string;
  readonly workspaceId: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
}

const MAX_MCP_CLAIM_LENGTH = 255;
const OAUTH_SCOPE_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/;

function claimIdentity(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 &&
      value.length <= MAX_MCP_CLAIM_LENGTH && value.trim() === value &&
      !/[\r\n\0]/.test(value)
    ? value
    : null;
}

function claimScopes(value: unknown): readonly string[] | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) {
    return null;
  }
  const scopes = value.split(" ");
  if (
    scopes.length > 64 ||
    scopes.some((scope) => !OAUTH_SCOPE_PATTERN.test(scope))
  ) {
    return null;
  }
  return [...new Set(scopes)];
}

export function parseMcpAccessTokenClaims(
  claims: unknown,
): AuthorizedMcpPrincipal | null {
  if (claims === null || typeof claims !== "object" || Array.isArray(claims)) {
    return null;
  }
  const payload = claims as Record<string, unknown>;
  const actorUserId = claimIdentity(payload.sub);
  const workspaceId = claimIdentity(payload[RELAY_WORKSPACE_ID_CLAIM]);
  const clientId = claimIdentity(payload.client_id);
  const scopes = claimScopes(payload.scope);
  if (
    actorUserId === null || workspaceId === null || clientId === null ||
    scopes === null
  ) {
    return null;
  }
  return { actorUserId, workspaceId, clientId, scopes };
}

export function requireMcpScopes(
  grantedScopes: readonly string[],
  requiredScopes: readonly string[],
): void {
  const granted = new Set(grantedScopes);
  const missing = requiredScopes.filter((scope) => !granted.has(scope));
  if (missing.length > 0) throw createInsufficientScopeError(missing);
}

export async function authorizeMcpAccessTokenClaims(
  queryable: Queryable,
  resource: string,
  claims: unknown,
): Promise<AuthorizedMcpPrincipal | null> {
  const principal = parseMcpAccessTokenClaims(claims);
  if (principal === null) return null;
  const result = await queryable.query<{ authorized: boolean }>(
    `select exists (
       select 1
         from auth."oauthClient" client
         join auth."oauthClientResource" client_resource
           on client_resource."clientId" = client."clientId"
         join auth."oauthResource" resource
           on resource.identifier = client_resource."resourceId"
         join auth.member member
           on member."organizationId" = $2 and member."userId" = $3
        where client."clientId" = $1
          and client.disabled is not true
          and resource.identifier = $4
          and resource.disabled is not true
     ) as authorized`,
    [
      principal.clientId,
      principal.workspaceId,
      principal.actorUserId,
      resource,
    ],
  );
  return result.rows[0]?.authorized === true ? principal : null;
}

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
    storeClientSecret: "hashed",
    clientPrivileges: async ({ user, session, action }) => {
      if (!user || !session) return false;
      if (!await isSuperadmin(queryable, user.id)) return false;
      if (action === "read" || action === "list") return true;
      // MCP integrations act through user consent, never a machine-only grant.
      if (action === "configure-client-credentials-scopes") return false;
      const age = Date.now() - new Date(session.createdAt).getTime();
      if (!Number.isFinite(age) || age < 0 || age > 15 * 60_000) {
        throw new APIError("FORBIDDEN", {
          code: "SESSION_TOO_OLD",
          message: "Sign in again before changing an OAuth client.",
        });
      }
      return true;
    },
    resourcePrivileges: () => Promise.resolve(false),
    refreshTokenReuseInterval: 30,
    postLogin: {
      page: "/oauth/workspace",
      // The provider re-evaluates this predicate on /oauth2/continue. Once a
      // current workspace is selected, continuing must be allowed to reach consent.
      shouldRedirect: async ({ scopes, user, session }) => {
        if (!requestsRelayResource(scopes)) return false;
        const workspaceId = session.activeOrganizationId;
        return typeof workspaceId !== "string" || !workspaceId ||
          await getMembership(queryable, workspaceId, user.id) === null;
      },
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
