import { Hono } from "@hono/hono";
import {
  type Auth,
  createManagedWorkspace,
  deleteManagedWorkspace,
  listManagedWorkspaces,
  listMcpConnections,
  type ManagedWorkspace,
  MAX_OWNED_WORKSPACES,
  type McpConnection,
  parseWorkspaceDetails,
  parseWorkspaceUpdate,
  proposeWorkspaceDetails,
  revokeMcpConnection,
  updateManagedWorkspace,
  type WorkspaceDetails,
  WorkspaceManagementError,
  type WorkspaceUpdate,
} from "@relay/auth";
import type { DatabasePool } from "@relay/database";
import {
  authenticationRequired,
  authorizationDenied,
  errorResponse,
  HttpAdapterError,
  idempotencyConflict,
  invalidRequest,
  notFound,
} from "../http/errors.ts";
import { assertNoQuery, readJsonBody } from "../http/request.ts";
import {
  createSessionMiddleware,
  type SessionVariables,
} from "../middleware/session.ts";

export interface WorkspaceManagementService {
  remove(sessionId: string, id: string, confirmation: string): Promise<void>;
  connections(sessionId: string): Promise<McpConnection[]>;
  revokeConnection(sessionId: string, id: string): Promise<void>;
  list(sessionId: string): Promise<ManagedWorkspace[]>;
  propose(sessionId: string): Promise<WorkspaceDetails>;
  create(sessionId: string, details: WorkspaceDetails, key: string): Promise<{
    workspace: ManagedWorkspace;
    replayed: boolean;
  }>;
  update(
    sessionId: string,
    id: string,
    details: WorkspaceUpdate,
  ): Promise<ManagedWorkspace>;
}

export function createPostgresWorkspaceManagementService(
  pool: DatabasePool,
): WorkspaceManagementService {
  return {
    remove: (sessionId, id, confirmation) =>
      deleteManagedWorkspace(pool, sessionId, id, confirmation),
    connections: (sessionId) => listMcpConnections(pool, sessionId),
    revokeConnection: (sessionId, id) =>
      revokeMcpConnection(pool, sessionId, id),
    list: (sessionId) => listManagedWorkspaces(pool, sessionId),
    propose: (sessionId) => proposeWorkspaceDetails(pool, sessionId),
    create: (sessionId, details, key) =>
      createManagedWorkspace(pool, sessionId, details, key),
    update: (sessionId, id, details) =>
      updateManagedWorkspace(pool, sessionId, id, details),
  };
}

export interface WorkspaceRouteDependencies {
  readonly auth: Auth;
  readonly service: WorkspaceManagementService;
  readonly allowedOrigins: readonly string[];
}

function mappedError(error: unknown): unknown {
  if (!(error instanceof WorkspaceManagementError)) return error;
  if (error.reason === "unauthenticated") return authenticationRequired();
  if (error.reason === "not_found") return notFound();
  if (error.reason === "owner_required") return authorizationDenied();
  if (error.reason === "idempotency_conflict") return idempotencyConflict();
  if (error.reason === "invalid_input") return invalidRequest();
  return new HttpAdapterError({
    status: 409,
    code: "invalid_request",
    message: error.reason === "personal_workspace"
      ? "Your personal workspace stays with your account. You can delete other workspaces you own."
      : error.reason === "workspace_busy"
      ? "Wait for active runs and uploads to finish, or cancel them, before deleting this workspace."
      : error.reason === "confirmation_required"
      ? "Enter the workspace handle to confirm deletion."
      : error.reason === "handle_immutable"
      ? "Workspace handles cannot be changed after creation. You can change the workspace name."
      : error.reason === "slug_taken"
      ? "That workspace handle is already in use. Choose another handle."
      : `You can own up to ${MAX_OWNED_WORKSPACES} workspaces, including your personal workspace.`,
  });
}

export function createWorkspaceRoutes(
  dependencies: WorkspaceRouteDependencies,
) {
  const root = "/api/v1/workspaces";
  const routes = new Hono<
    {
      Variables: SessionVariables & {
        requestId: string;
        workspaceSession: string;
      };
    }
  >();
  const origins = new Set(dependencies.allowedOrigins);
  routes.use(`${root}/*`, async (context, next) => {
    context.set(
      "requestId",
      context.get("requestId") ?? `req_${crypto.randomUUID()}`,
    );
    context.header("cache-control", "no-store");
    context.header("x-content-type-options", "nosniff");
    if (
      context.req.method !== "GET" &&
      !origins.has(context.req.header("origin") ?? "")
    ) {
      throw authorizationDenied();
    }
    assertNoQuery(context.req.raw);
    await next();
  });
  routes.use(`${root}/*`, createSessionMiddleware(dependencies.auth));
  routes.use(`${root}/*`, async (context, next) => {
    const id = context.get("session")?.session.id;
    if (!id) throw authenticationRequired();
    context.set("workspaceSession", id);
    await next();
  });
  routes.onError((error, context) =>
    errorResponse(context, mappedError(error), context.get("requestId"))
  );
  routes.get(root, async (context) =>
    context.json({
      items: await dependencies.service.list(context.get("workspaceSession")),
      maxOwnedWorkspaces: MAX_OWNED_WORKSPACES,
    }));
  routes.get(`${root}/suggestion`, async (context) =>
    context.json(
      await dependencies.service.propose(context.get("workspaceSession")),
    ));
  routes.get(`${root}/connections`, async (context) =>
    context.json({
      items: await dependencies.service.connections(
        context.get("workspaceSession"),
      ),
    }));
  routes.delete(`${root}/connections/:id`, async (context) => {
    const id = context.req.param("id");
    if (!id || id.length > 255) throw invalidRequest();
    await dependencies.service.revokeConnection(
      context.get("workspaceSession"),
      id,
    );
    return context.json({ disconnected: true });
  });
  routes.post(root, async (context) => {
    const key = context.req.header("idempotency-key") ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key)) {
      throw invalidRequest();
    }
    const body = parseWorkspaceDetails(
      await readJsonBody(context.req.raw, 2048),
    );
    const result = await dependencies.service.create(
      context.get("workspaceSession"),
      body,
      key,
    );
    return context.json(result, result.replayed ? 200 : 201);
  });
  routes.patch(`${root}/:id`, async (context) => {
    const id = context.req.param("id");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(id)
    ) throw notFound();
    const body = parseWorkspaceUpdate(
      await readJsonBody(context.req.raw, 70_000),
    );
    return context.json({
      workspace: await dependencies.service.update(
        context.get("workspaceSession"),
        id,
        body,
      ),
    });
  });
  routes.delete(`${root}/:id`, async (context) => {
    const body = await readJsonBody(context.req.raw, 1024);
    if (
      typeof body !== "object" || body === null || !("confirmation" in body) ||
      typeof body.confirmation !== "string" || Object.keys(body).length !== 1
    ) throw invalidRequest();
    await dependencies.service.remove(
      context.get("workspaceSession"),
      context.req.param("id"),
      body.confirmation,
    );
    return context.json({ deleted: true });
  });
  return routes;
}
