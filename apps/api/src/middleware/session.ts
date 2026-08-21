import type { Context, Next } from "@hono/hono";
import type { Auth } from "@relay/auth";

export interface SessionVariables {
  session: Awaited<ReturnType<Auth["api"]["getSession"]>>;
}

/**
 * Populates `c.get("session")` for every request so downstream routes can
 * read it without each calling `auth.api.getSession` themselves.
 * `activeOrganizationId` on that session is context only -- routes still
 * must call `getMembership` (see @relay/auth's authorization.ts) before
 * trusting a client-supplied workspace ID.
 */
export function createSessionMiddleware(auth: Auth) {
  return async (c: Context, next: Next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    c.set("session", session);
    await next();
  };
}
