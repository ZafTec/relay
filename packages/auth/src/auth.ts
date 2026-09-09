import {
  mcp,
  requireMcpAuth,
  type RequireMcpAuthOptions,
} from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { RELAY_MCP_WORKSPACE_SCOPES } from "@relay/contracts";
import {
  requireS256Authorization,
  validateRelayClientMetadata,
} from "./oauth-client-policy.ts";
import { jwt } from "better-auth/plugins/jwt";
// Better Auth exposes these tree-shakeable entry points only as npm package
// subpaths; keep them pinned to the same version as the root import map.
// deno-lint-ignore no-import-prefix
import { organization } from "npm:better-auth@1.7.2/plugins/organization";
// deno-lint-ignore no-import-prefix
import { github, google } from "npm:better-auth@1.7.2/social-providers";
import type { AuthConfig } from "@relay/config";
import type { DatabasePool } from "@relay/database";
import {
  type AuthorizedMcpPrincipal,
  authorizeMcpAccessTokenClaims,
  createMcpOAuthOptions,
  RELAY_AUTHORIZATION_SCOPES,
  relayMcpResource,
  requireCurrentVerifiedEmail,
  requireMcpScopes,
} from "./oauth.ts";
import {
  type AuthConnectionInfo,
  prepareAuthRequest,
  RELAY_CLIENT_IP_HEADER,
} from "./proxy.ts";
import { ensurePersonalWorkspace } from "./workspaces.ts";
import { parseImageSource } from "./image-source.ts";
import {
  createMcpOAuthClientManager,
  type ManageMcpOAuthClient,
} from "./oauth-management.ts";

const HIGH_RISK_SESSION_FRESHNESS_SECONDS = 15 * 60;

const ORGANIZATION_PATH_PREFIX = "/api/auth/organization/";
const ALLOWED_ORGANIZATION_REQUESTS = new Set([
  "GET /api/auth/organization/get-active-member",
  "GET /api/auth/organization/get-active-member-role",
  "GET /api/auth/organization/get-full-organization",
  "GET /api/auth/organization/get-invitation",
  "GET /api/auth/organization/get-organization",
  "GET /api/auth/organization/list",
  "GET /api/auth/organization/list-invitations",
  "GET /api/auth/organization/list-members",
  "GET /api/auth/organization/list-user-invitations",
  "POST /api/auth/organization/check-slug",
  "POST /api/auth/organization/has-permission",
  "POST /api/auth/organization/set-active",
]);

interface AuthSession {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly activeOrganizationId?: string | null;
  readonly [key: string]: unknown;
}

interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly [key: string]: unknown;
}

export type McpRequestHandler = Parameters<typeof requireMcpAuth>[1];
export type ProtectMcpOptions = Omit<RequireMcpAuthOptions, "resource">;

/** Production-facing auth surface. Privileged adapters/test helpers stay out. */
export interface Auth {
  readonly handler: (
    request: Request,
    connection?: AuthConnectionInfo,
  ) => Response | Promise<Response>;
  readonly api: {
    getSession(
      args: { headers: Headers },
    ): Promise<{ session: AuthSession; user: AuthUser } | null>;
  };
  readonly mcpResource: string;
  readonly manageMcpOAuthClient: ManageMcpOAuthClient;
  readonly authorizeMcpClaims: (
    claims: unknown,
  ) => Promise<AuthorizedMcpPrincipal | null>;
  readonly requireMcpScopes: (
    grantedScopes: readonly string[],
    requiredScopes: readonly string[],
  ) => void;
  readonly protectMcp: (
    handler: McpRequestHandler,
    options?: ProtectMcpOptions,
  ) => (
    request: Request,
    connection?: AuthConnectionInfo,
  ) => Promise<Response>;
}

export function isDeferredOrganizationMutation(request: Request): boolean {
  const pathname = new URL(request.url).pathname.replace(/\/+$/, "");
  if (!pathname.startsWith(ORGANIZATION_PATH_PREFIX)) return false;
  return !ALLOWED_ORGANIZATION_REQUESTS.has(`${request.method} ${pathname}`);
}

function deferredOrganizationMutationResponse(): Response {
  return Response.json(
    {
      error: {
        code: "not_found",
        message: "The requested resource was not found.",
      },
    },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
}

/**
 * Shared production options used by the isolated test-only instance. This is a
 * direct module export, not part of `@relay/auth`'s public package surface.
 */
export function createAuthOptions(pool: DatabasePool, config: AuthConfig) {
  const workspaceContinuations = new WeakSet<Headers>();
  const googleOptions = {
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    scope: ["openid", "email", "profile"],
  };
  const githubOptions = {
    clientId: config.github.clientId,
    clientSecret: config.github.clientSecret,
    scope: ["read:user", "user:email"],
  };

  return {
    appName: "Relay",
    baseURL: config.baseUrl.toString(),
    basePath: "/api/auth",
    secret: config.secret,
    database: pool,
    trustedOrigins: [...config.trustedOrigins],
    disabledPaths: ["/token"],

    // No emailAndPassword config -> disabled. OAuth-only, no magic-link/OTP.
    socialProviders: {
      google: {
        ...googleOptions,
        requireEmailVerification: true,
        getUserInfo: requireCurrentVerifiedEmail(
          google(googleOptions).getUserInfo,
        ),
      },
      github: {
        ...githubOptions,
        requireEmailVerification: true,
        getUserInfo: requireCurrentVerifiedEmail(
          github(githubOptions).getUserInfo,
        ),
      },
    },

    session: {
      // Revocation and role changes must be visible immediately, not after a
      // cache window. The freshness window is also available to high-risk
      // service APIs even though their HTTP routes are not implemented yet.
      cookieCache: { enabled: false },
      freshAge: HIGH_RISK_SESSION_FRESHNESS_SECONDS,
    },

    account: {
      encryptOAuthTokens: true,
      accountLinking: { enabled: false },
    },

    rateLimit: {
      enabled: true,
      storage: "database" as const,
      customRules: {
        "/oauth2/register": { window: 60, max: 10 },
        "/oauth2/create-client": { window: 60, max: 10 },
      },
    },

    hooks: {
      // Better Auth requires an asynchronous middleware signature.
      // deno-lint-ignore require-await
      before: createAuthMiddleware(async (context) => {
        if (
          context.path === "/update-user" && context.body &&
          "image" in context.body
        ) {
          try {
            context.body.image = parseImageSource(context.body.image);
          } catch {
            throw new APIError("BAD_REQUEST", {
              message:
                "Choose a PNG, JPEG or WebP photo, or an HTTPS image URL.",
            });
          }
        }
        if (
          ["/oauth2/register", "/oauth2/create-client", "/oauth2/update-client"]
            .includes(context.path)
        ) {
          const metadata = context.path === "/oauth2/update-client"
            ? context.body?.update
            : context.body;
          validateRelayClientMetadata(metadata);
          if (
            metadata.application_type === undefined &&
            metadata.redirect_uris?.some((uri: string) =>
              uri.startsWith("http://")
            )
          ) {
            metadata.application_type = "native";
          }
        }
        if (context.path === "/oauth2/authorize") {
          requireS256Authorization(context.query);
          if (!context.query?.scope) {
            return {
              context: {
                query: {
                  ...context.query,
                  scope: [
                    ...RELAY_AUTHORIZATION_SCOPES,
                    ...RELAY_MCP_WORKSPACE_SCOPES,
                  ].join(" "),
                },
              },
            };
          }
        }
        if (
          context.path === "/oauth2/continue" &&
          context.body?.postLogin === true && context.request
        ) {
          workspaceContinuations.add(context.request.headers);
        }
      }),
    },

    advanced: {
      useSecureCookies: config.baseUrl.protocol === "https:",
      disableCSRFCheck: false,
      disableOriginCheck: false,
      // A fixed base URL never needs forwarded host/protocol inference.
      trustedProxyHeaders: false,
      ipAddress: {
        // apps/api replaces every caller-supplied forwarding header and sets
        // this only from the runtime peer plus an explicit proxy allowlist.
        ipAddressHeaders: [RELAY_CLIENT_IP_HEADER],
      },
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax" as const,
      },
      crossSubDomainCookies: { enabled: false },
    },

    plugins: [
      organization({
        allowUserToCreateOrganization: false,
        creatorRole: "owner",
        disableOrganizationDeletion: true,
        teams: { enabled: false },
        dynamicAccessControl: { enabled: false },
      }),
      jwt({ disableSettingJwtHeader: true }),
      mcp(createMcpOAuthOptions(pool, config.baseUrl, {
        isWorkspaceContinuation: (headers) =>
          workspaceContinuations.has(headers),
      })),
    ],

    databaseHooks: {
      session: {
        create: {
          before: async (session: { userId: string }) => {
            // Provider callbacks are gated on their current response above.
            // This fresh database check is defense in depth for every other
            // session-creation path, including privileged test helpers.
            const emailVerified = await pool.query<
              { emailVerified: boolean }
            >(
              `select "emailVerified" from auth."user" where id = $1`,
              [session.userId],
            );
            if (!emailVerified.rows[0]?.emailVerified) {
              throw new Error(
                "A verified email address is required to sign in.",
              );
            }

            const organizationId = await ensurePersonalWorkspace(
              pool,
              session.userId,
            );
            return {
              data: { ...session, activeOrganizationId: organizationId },
            };
          },
        },
      },
    },
  };
}

/** One Better Auth instance per API process, sharing its PostgreSQL pool. */
export function createAuth(pool: DatabasePool, config: AuthConfig): Auth {
  const auth = betterAuth(createAuthOptions(pool, config));
  const mcpResource = relayMcpResource(config.baseUrl);

  return {
    handler: (request, connection) => {
      if (isDeferredOrganizationMutation(request)) {
        return deferredOrganizationMutationResponse();
      }
      return auth.handler(prepareAuthRequest(request, connection));
    },
    api: {
      getSession: (args) => auth.api.getSession(args),
    },
    mcpResource,
    manageMcpOAuthClient: createMcpOAuthClientManager(pool, auth),
    authorizeMcpClaims: (claims) =>
      authorizeMcpAccessTokenClaims(pool, mcpResource, claims),
    requireMcpScopes,
    protectMcp: (handler, options) => {
      const protectedHandler = requireMcpAuth(auth, handler, {
        ...options,
        resource: mcpResource,
        challengeScopes: options?.challengeScopes ?? RELAY_MCP_WORKSPACE_SCOPES,
      });
      return (request, connection) => {
        const prepared = prepareAuthRequest(request, connection);
        return protectedHandler(new Request(mcpResource, prepared));
      };
    },
  };
}
