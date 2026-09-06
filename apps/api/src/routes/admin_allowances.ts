import { Hono } from "@hono/hono";
import type { Auth } from "@relay/auth";
import type { DatabasePool } from "@relay/database";
import {
  type AllowanceAuditEvent,
  type AllowanceGrant,
  AllowanceInputError,
  type AllowanceMutationResult,
  type AllowancePage,
  type AllowanceSummary,
  allowanceText,
  type AllowanceWorkspace,
  getWorkspaceAllowances,
  type GrantAllowanceInput,
  listAllowanceAudit,
  listAllowanceGrants,
  listAllowanceWorkspaces,
  manageWorkspaceAllowance,
  parseGrantAllowanceInput,
  parseRevokeAllowanceInput,
  type RevokeAllowanceInput,
} from "@relay/metering";
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

export interface AdminAllowanceService {
  workspaces(
    sessionId: string,
    search: string,
    after: string | null,
  ): Promise<AllowancePage<AllowanceWorkspace>>;
  summary(
    sessionId: string,
    workspaceId: string,
  ): Promise<AllowanceSummary | null>;
  grants(
    sessionId: string,
    workspaceId: string,
    before: string | null,
  ): Promise<AllowancePage<AllowanceGrant>>;
  audit(
    sessionId: string,
    workspaceId: string,
    before: string | null,
  ): Promise<AllowancePage<AllowanceAuditEvent>>;
  mutate(
    sessionId: string,
    workspaceId: string,
    operation: "grant" | "revoke",
    input: GrantAllowanceInput | RevokeAllowanceInput,
    key: string,
    requestId: string,
  ): Promise<AllowanceMutationResult>;
}
export function createPostgresAdminAllowanceService(
  pool: DatabasePool,
): AdminAllowanceService {
  return {
    workspaces: (session, search, after) =>
      listAllowanceWorkspaces(pool, session, search, after),
    summary: (session, workspace) =>
      getWorkspaceAllowances(pool, session, workspace),
    grants: (session, workspace, before) =>
      listAllowanceGrants(pool, session, workspace, before),
    audit: (session, workspace, before) =>
      listAllowanceAudit(pool, session, workspace, before),
    mutate: (session, workspace, operation, input, key, request) =>
      manageWorkspaceAllowance(
        pool,
        session,
        workspace,
        operation,
        input,
        key,
        request,
      ),
  };
}
export interface AdminAllowanceRouteDependencies {
  auth: Auth;
  service: AdminAllowanceService;
  allowedOrigins: readonly string[];
  onUnexpectedError?: (
    error: unknown,
    requestId: string,
    route: string,
  ) => void;
}
const ROOT = "/api/v1/admin/allowances";
type Environment = {
  Variables: SessionVariables & { requestId: string; operatorSession: string };
};
function query(request: Request, fields: string[]): URLSearchParams {
  const url = new URL(request.url);
  if (url.search.length > 2048) throw invalidRequest();
  for (const key of url.searchParams.keys()) {
    if (!fields.includes(key) || url.searchParams.getAll(key).length !== 1) {
      throw invalidRequest();
    }
  }
  return url.searchParams;
}
function mappedError(error: unknown): unknown {
  if (error instanceof HttpAdapterError) return error;
  if (error instanceof AllowanceInputError) return invalidRequest();
  const code = typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
  if (code === "42501") return authorizationDenied();
  if (code === "28000" || code === "55000") return reauthenticationRequired();
  if (code === "RG001") return idempotencyConflict();
  if (code === "RA404") return notFound();
  if (code === "RA409") {
    return new HttpAdapterError({
      status: 409,
      code: "invalid_request",
      message: "This grant was already revoked. Refresh the workspace.",
    });
  }
  if (["22023", "22007", "22008"].includes(String(code))) {
    return invalidRequest();
  }
  return error;
}
export function createAdminAllowanceRoutes(
  dependencies: AdminAllowanceRouteDependencies,
) {
  const routes = new Hono<Environment>();
  const origins = new Set(dependencies.allowedOrigins.map((origin) => {
    const parsed = new URL(origin);
    if (
      !["https:", "http:"].includes(parsed.protocol) || parsed.origin !== origin
    ) throw new TypeError("Expected an HTTP origin");
    return origin;
  }));
  routes.use(`${ROOT}/*`, async (context, next) => {
    context.set(
      "requestId",
      context.get("requestId") ?? `req_${crypto.randomUUID()}`,
    );
    context.header("x-request-id", context.get("requestId"));
    context.header("cache-control", "no-store");
    context.header("x-content-type-options", "nosniff");
    if (
      context.req.method !== "GET" &&
      !origins.has(context.req.header("origin") ?? "")
    ) throw authorizationDenied();
    await next();
  });
  routes.use(`${ROOT}/*`, createSessionMiddleware(dependencies.auth));
  routes.use(`${ROOT}/*`, async (context, next) => {
    const id = context.get("session")?.session.id;
    if (!id || id.length > 256) throw authenticationRequired();
    context.set("operatorSession", id);
    await next();
  });
  routes.onError((error, context) => {
    const mapped = mappedError(error);
    if (!(mapped instanceof HttpAdapterError)) {
      try {
        dependencies.onUnexpectedError?.(
          error,
          context.get("requestId"),
          context.req.routePath,
        );
      } catch { /* best effort */ }
    }
    return errorResponse(
      context,
      mapped,
      context.get("requestId") ?? `req_${crypto.randomUUID()}`,
    );
  });
  routes.get(`${ROOT}/workspaces`, async (context) => {
    const values = query(context.req.raw, ["search", "after"]);
    return context.json(
      await dependencies.service.workspaces(
        context.get("operatorSession"),
        values.get("search") ?? "",
        values.get("after"),
      ),
    );
  });
  const workspacePath = `${ROOT}/workspaces/:workspaceId`;
  routes.get(workspacePath, async (context) => {
    assertNoQuery(context.req.raw);
    const result = await dependencies.service.summary(
      context.get("operatorSession"),
      allowanceText(context.req.param("workspaceId")),
    );
    if (result === null) throw notFound();
    return context.json(result);
  });
  for (const section of ["grants", "audit"] as const) {
    routes.get(`${workspacePath}/${section}`, async (context) => {
      const values = query(context.req.raw, ["before"]);
      return context.json(
        await dependencies.service[section](
          context.get("operatorSession"),
          allowanceText(context.req.param("workspaceId")),
          values.get("before"),
        ),
      );
    });
  }
  for (const operation of ["grant", "revoke"] as const) {
    routes.post(`${workspacePath}/${operation}`, async (context) => {
      assertNoQuery(context.req.raw);
      const key = context.req.header("idempotency-key") ?? "";
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key)) {
        throw invalidRequest({
          field: "idempotency-key",
          reason: "invalid_value",
        });
      }
      const body = await readJsonBody(context.req.raw, 8192);
      const input = operation === "grant"
        ? parseGrantAllowanceInput(body)
        : parseRevokeAllowanceInput(body);
      return context.json(
        await dependencies.service.mutate(
          context.get("operatorSession"),
          allowanceText(context.req.param("workspaceId")),
          operation,
          input,
          key,
          context.get("requestId"),
        ),
      );
    });
  }
  routes.all(`${ROOT}/*`, () => {
    throw notFound();
  });
  return routes;
}
