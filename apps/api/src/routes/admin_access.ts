import { Hono } from "@hono/hono";
import type { Auth } from "@relay/auth";
import type { DatabasePool } from "@relay/database";
import {
  authenticationRequired,
  authorizationDenied,
  errorResponse,
  HttpAdapterError,
  idempotencyConflict,
  invalidRequest,
  notFound,
  reauthenticationRequired,
} from "../http/errors.ts";
import { assertNoQuery, readJsonBody } from "../http/request.ts";
import {
  createSessionMiddleware,
  type SessionVariables,
} from "../middleware/session.ts";

export interface SuperadminAccessService {
  access(session: string): Promise<boolean>;
  list(session: string): Promise<unknown>;
  invite(session: string, id: string, email: string): Promise<unknown>;
  revoke(session: string, id: string): Promise<unknown>;
  accept(session: string, id: string, accept: boolean): Promise<unknown>;
}

export function createPostgresSuperadminAccessService(
  pool: DatabasePool,
): SuperadminAccessService {
  async function query(sql: string, args: unknown[]) {
    return (await pool.query<{ result: unknown }>(sql, args)).rows[0].result;
  }
  return {
    async access(session) {
      const result = await pool.query<{ allowed: boolean }>(
        `select exists (
          select 1 from auth.session s
          join auth."user" u on u.id = s."userId" and u."emailVerified" is true
          join relay.system_role_assignments r on r.user_id = u.id and r.revoked_at is null
          where s.id = $1 and s."expiresAt" > now()
        ) as allowed`,
        [session],
      );
      return result.rows[0]?.allowed === true;
    },
    list: (session) =>
      query("select relay.list_superadmin_access($1) as result", [session]),
    invite: (session, id, email) =>
      query("select relay.create_superadmin_invitation($1,$2,$3) as result", [
        session,
        id,
        email,
      ]),
    revoke: (session, id) =>
      query("select relay.revoke_superadmin_invitation($1,$2) as result", [
        session,
        id,
      ]),
    accept: (session, id, accept) =>
      query("select relay.accept_superadmin_invitation($1,$2,$3) as result", [
        session,
        id,
        accept,
      ]),
  };
}

export interface SuperadminAccessRouteDependencies {
  auth: Auth;
  service: SuperadminAccessService;
  allowedOrigins: readonly string[];
}

function invitationId(value: string): string {
  if (!/^sinv_[0-9a-f]{32}$/.test(value)) throw notFound();
  return value;
}

export function createSuperadminAccessRoutes(
  dependencies: SuperadminAccessRouteDependencies,
) {
  const routes = new Hono<
    {
      Variables: SessionVariables & {
        operatorSession: string;
        requestId: string;
      };
    }
  >();
  const admin = "/api/v1/admin/superadmins";
  const acceptance = "/api/v1/superadmin-invitations";
  const origins = new Set(dependencies.allowedOrigins);
  for (const root of [admin, acceptance, "/api/v1/admin/access"]) {
    routes.use(`${root}/*`, async (context, next) => {
      context.header("cache-control", "no-store");
      context.header("x-content-type-options", "nosniff");
      context.set(
        "requestId",
        context.get("requestId") ?? `req_${crypto.randomUUID()}`,
      );
      if (
        context.req.method !== "GET" &&
        !origins.has(context.req.header("origin") ?? "")
      ) throw authorizationDenied();
      assertNoQuery(context.req.raw);
      await next();
    });
    routes.use(`${root}/*`, createSessionMiddleware(dependencies.auth));
    routes.use(`${root}/*`, async (context, next) => {
      const session = context.get("session")?.session.id;
      if (!session) throw authenticationRequired();
      context.set("operatorSession", session);
      await next();
    });
  }
  routes.onError((error, context) => {
    const code = "code" in error ? String(error.code) : "";
    const mapped = code === "42501"
      ? authorizationDenied()
      : ["28000", "55000"].includes(code)
      ? reauthenticationRequired()
      : code === "RA404"
      ? notFound()
      : code === "RG001"
      ? idempotencyConflict()
      : code === "22023"
      ? invalidRequest()
      : code === "RA409"
      ? new HttpAdapterError({
        status: 409,
        code: "invalid_request",
        message:
          "This account or invitation has already changed. Refresh the list.",
      })
      : error;
    return errorResponse(
      context,
      mapped,
      context.get("requestId") ?? `req_${crypto.randomUUID()}`,
    );
  });
  routes.get(
    "/api/v1/admin/access",
    async (context) => {
      if (!await dependencies.service.access(context.get("operatorSession"))) {
        throw authorizationDenied();
      }
      return context.json({ allowed: true });
    },
  );
  routes.get(
    admin,
    async (context) =>
      context.json(
        await dependencies.service.list(context.get("operatorSession")),
      ),
  );
  routes.post(`${admin}/invitations`, async (context) => {
    const key = context.req.header("idempotency-key") ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key)) {
      throw invalidRequest();
    }
    const body = await readJsonBody(context.req.raw, 2048);
    if (
      typeof body !== "object" || body === null || Array.isArray(body) ||
      Object.keys(body).length !== 1 || !("email" in body) ||
      typeof body.email !== "string"
    ) throw invalidRequest();
    const email = body.email.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw invalidRequest();
    }
    const actor = context.get("session")!.user.id;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify([actor, key])),
    );
    const id = "sinv_" +
      Array.from(
        new Uint8Array(digest),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("").slice(0, 32);
    return context.json(
      await dependencies.service.invite(
        context.get("operatorSession"),
        id,
        email,
      ),
    );
  });
  routes.delete(
    `${admin}/invitations/:id`,
    async (context) =>
      context.json({
        result: await dependencies.service.revoke(
          context.get("operatorSession"),
          invitationId(context.req.param("id")),
        ),
      }),
  );
  routes.get(
    `${acceptance}/:id`,
    async (context) =>
      context.json(
        await dependencies.service.accept(
          context.get("operatorSession"),
          invitationId(context.req.param("id")),
          false,
        ),
      ),
  );
  routes.post(`${acceptance}/:id`, async (context) => {
    const body = await readJsonBody(context.req.raw, 1024);
    if (
      typeof body !== "object" || body === null || Array.isArray(body) ||
      Object.keys(body).length !== 1 || !("accept" in body) ||
      body.accept !== true
    ) throw invalidRequest();
    return context.json(
      await dependencies.service.accept(
        context.get("operatorSession"),
        invitationId(context.req.param("id")),
        true,
      ),
    );
  });
  return routes;
}
