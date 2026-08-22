import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import type { AuthConfig } from "@relay/config";
import type { DatabasePool } from "@relay/database";
import { ensurePersonalWorkspace } from "./workspaces.ts";
import type { BetterAuthAdapter } from "./workspaces.ts";

interface AuthSession {
  readonly id: string;
  readonly userId: string;
  readonly activeOrganizationId?: string | null;
  readonly [key: string]: unknown;
}

interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly [key: string]: unknown;
}

/**
 * Deliberately narrow -- only the surface Relay actually calls, not Better
 * Auth's full (and very large, config-shape-dependent generic) instance
 * type. `betterAuth(...)`'s real return type is a conditional type keyed
 * off the exact options object; there is no concise explicit annotation
 * for it, so `createAuth` below builds the real instance and hands it back
 * through this interface instead.
 */
export interface Auth {
  readonly handler: (request: Request) => Response | Promise<Response>;
  readonly api: {
    getSession(
      args: { headers: Headers },
    ): Promise<{ session: AuthSession; user: AuthUser } | null>;
  };
  readonly $context: Promise<{
    adapter: BetterAuthAdapter;
    /**
     * Lower-level than `api.*` -- bypasses request/auth handling entirely.
     * Exposed here (rather than kept private to auth.ts) only because
     * tests need to create a session without a real OAuth round trip; no
     * production code outside this package should call it.
     */
    internalAdapter: {
      createSession(
        userId: string,
        request?: unknown,
        dontRememberMe?: boolean,
        override?: Record<string, unknown>,
        overrideAll?: boolean,
      ): Promise<AuthSession>;
    };
  }>;
}

/**
 * One Better Auth instance per process, sharing the process's `pg.Pool`
 * (docs/implementation-handoff/03-auth-workspaces.md "Server configuration").
 * Security settings below map directly to that section's "Security
 * decisions" list; see each inline comment for which one.
 */
export function createAuth(pool: DatabasePool, config: AuthConfig): Auth {
  const auth = betterAuth({
    appName: "Relay",
    baseURL: config.baseUrl.toString(),
    basePath: "/api/auth",
    secret: config.secret,
    database: pool,
    trustedOrigins: [...config.trustedOrigins],

    // No emailAndPassword config -> disabled. OAuth-only, no magic-link/OTP.
    socialProviders: {
      google: {
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        scope: ["openid", "email", "profile"],
      },
      github: {
        clientId: config.github.clientId,
        clientSecret: config.github.clientSecret,
        scope: ["read:user", "user:email"],
      },
    },

    session: {
      // Revocation and role changes must be visible immediately, not after
      // a cache window.
      cookieCache: { enabled: false },
    },

    account: {
      // OAuth tokens encrypted at rest.
      encryptOAuthTokens: true,
      // Implicit same-email linking disabled. Explicit linking is a
      // separate, not-yet-built authenticated UI/service task -- disabling
      // linking entirely (not just the implicit path) makes that
      // "unavailable" rather than silently reachable through a lower-level
      // API.
      accountLinking: { enabled: false },
    },

    rateLimit: {
      enabled: true,
      // Database-backed initially; a Redis secondaryStorage may be added
      // later without moving durable sessions.
      storage: "database",
      // TODO(Wave 6/CI): once the production Nginx network is finalized,
      // set advanced.ipAddress.trustedProxies to that network only --
      // trusting a forwarded client-IP header from an untrusted source
      // would let one caller spoof another's rate-limit identity, per
      // docs/implementation-handoff/03-auth-workspaces.md "Proxy, origin,
      // and cookie policy". Without it, Better Auth currently falls back
      // to a single shared per-path bucket (logs a WARN, does not fail).
    },

    advanced: {
      // https:// in production, http:// for local dev -- avoids a separate
      // APP_ENV concept purely for this.
      useSecureCookies: config.baseUrl.protocol === "https:",
      disableCSRFCheck: false,
      disableOriginCheck: false,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
      },
      // Host-only cookies -- no .zaftech.co cross-subdomain cookie.
      crossSubDomainCookies: { enabled: false },
    },

    plugins: [
      organization({
        // Users cannot create arbitrary organizations; the server creates
        // exactly one personal organization per user (see
        // databaseHooks.session.create.before below).
        allowUserToCreateOrganization: false,
        creatorRole: "owner",
        disableOrganizationDeletion: true,
      }),
    ],

    databaseHooks: {
      session: {
        create: {
          // Hard gate for personal-workspace provisioning: every session
          // gets an activeOrganizationId before it exists. A user-create
          // after-hook alone can't be the only mechanism (a failed
          // after-hook would leave an existing user without a workspace),
          // so this is the one place that's guaranteed to run.
          //
          // Uses the adapter directly, not auth.api.createOrganization --
          // spiked against live PostgreSQL 18 and found that
          // auth.api.createOrganization rejects with 401 even with a
          // userId body and no session headers, contradicting what the
          // public docs describe. ensurePersonalWorkspace's own
          // database-level uniqueness (not this hook) is what makes
          // concurrent sign-ins converge on one workspace; this closure
          // over `auth` is safe only because the hook doesn't run until a
          // real request arrives, well after this module finishes
          // evaluating.
          before: async (session: { userId: string }) => {
            // Requires a *currently* verified email, not just "was
            // verified at some point" -- read fresh on every session
            // rather than trusted from anywhere cached. Google/GitHub
            // (packages/auth's only providers) both report a real
            // per-address verified flag (Google's email_verified OIDC
            // claim; GitHub's verified flag on the specific address in
            // use, via @better-auth/core's provider adapters), and
            // Better Auth persists it verbatim as the local user's
            // emailVerified on sign-up. This is the same hook personal-
            // workspace provisioning already runs in -- the one place
            // guaranteed to run before any session exists -- so an
            // unverified user is refused a session (and never gets a
            // workspace provisioned) rather than merely warned.
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

            const ctx = await auth.$context;
            const organizationId = await ensurePersonalWorkspace(
              ctx.adapter,
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
  });

  return auth as unknown as Auth;
}
