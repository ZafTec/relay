import { Hono } from "@hono/hono";
import {
  type ApplicationServices,
  InvalidCursorError,
  validateIdempotencyKey,
} from "@relay/application";
import {
  cancelRunResultSchema,
  completeArtifactUploadResultSchema,
  createArtifactDownloadRequestSchema,
  createArtifactDownloadResultSchema,
  createArtifactUploadRequestSchema,
  createArtifactUploadResultSchema,
  createRunRequestSchema,
  createRunResultSchema,
  createShareLinkRequestSchema,
  createShareLinkResultSchema,
  getArtifactResultSchema,
  getRunResultSchema,
  getToolResultSchema,
  getUsageSummaryResultSchema,
  HTTP_PATHS,
  listArtifactsRequestSchema,
  listArtifactsResultSchema,
  listRunsRequestSchema,
  listRunsResultSchema,
  listToolsRequestSchema,
  listToolsResultSchema,
  PUBLIC_ID_PATTERNS,
  resolveShareLinkResultSchema,
  revokeShareLinkResultSchema,
  runPath,
  TOOL_KEY_PATTERN,
  usageSummaryRequestSchema,
} from "@relay/contracts";
import { createWorkspaceEventResponse } from "../http/events.ts";
import type { WorkspaceEventStreamOptions } from "../http/events.ts";
import {
  errorResponse,
  HttpAdapterError,
  invalidRequest,
  notFound,
} from "../http/errors.ts";
import {
  optionalActorUserId,
  requireWorkspaceIdentity,
  type SessionIdentityResolver,
} from "../http/identity.ts";
import {
  assertEmptyBody,
  assertNoQuery,
  DEFAULT_MAX_JSON_BODY_BYTES,
  parseContractInput,
  parseQuery,
  readJsonBody,
  readOptionalJsonObject,
} from "../http/request.ts";

export { createAuthSessionIdentityResolver } from "../http/identity.ts";
export type {
  ActiveWorkspaceIdentity,
  SessionIdentityResolution,
  SessionIdentityResolver,
  WorkspaceMembershipRole,
} from "../http/identity.ts";
export type {
  WorkspaceEventSource,
  WorkspaceEventStreamOptions,
  WorkspaceEventWaitRequest,
} from "../http/events.ts";
export {
  POLLING_WORKSPACE_EVENT_SOURCE,
  SSE_RESYNCHRONIZED_EVENT,
} from "../http/events.ts";

export const V1_ADAPTER_PATHS = Object.freeze({
  tool: `${HTTP_PATHS.tools}/:toolKey`,
  artifactDownload: `${HTTP_PATHS.artifact}/download`,
});

interface V1Environment {
  Variables: {
    requestId: string;
  };
}

export interface V1RouteDependencies {
  readonly services: ApplicationServices;
  readonly resolveIdentity: SessionIdentityResolver;
  readonly maxJsonBodyBytes?: number;
  readonly queueRetryAfterSeconds?: number;
  readonly eventStream?: WorkspaceEventStreamOptions;
  readonly createRequestId?: () => string;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const DEFAULT_QUEUE_RETRY_AFTER_SECONDS = 60;

function configuredPositiveInteger(
  value: number | undefined,
  fallback: number,
  field: string,
  maximum: number,
): number {
  const selected = value ?? fallback;
  if (
    !Number.isSafeInteger(selected) || selected < 1 || selected > maximum
  ) {
    throw new TypeError(`${field} must be a positive bounded integer`);
  }
  return selected;
}

function createRequestId(factory: (() => string) | undefined): string {
  try {
    const candidate = factory?.() ?? `req_${crypto.randomUUID()}`;
    if (REQUEST_ID_PATTERN.test(candidate)) return candidate;
  } catch {
    // Correlation is best effort and must not reject the request.
  }
  return `req_${crypto.randomUUID()}`;
}

function requireResourceId(
  value: string,
  pattern: RegExp,
): string {
  if (!pattern.test(value)) throw notFound();
  return value;
}

function requireToolKey(value: string): string {
  if (value.length > 128 || !TOOL_KEY_PATTERN.test(value)) throw notFound();
  return value;
}

function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key");
  if (key === null) {
    throw invalidRequest({
      field: "idempotency-key",
      reason: "missing_header",
    });
  }
  try {
    return validateIdempotencyKey(key);
  } catch {
    throw invalidRequest({
      field: "idempotency-key",
      reason: "invalid_header",
    });
  }
}

function bindPathField(
  body: Record<string, unknown>,
  field: string,
  value: string,
): Record<string, unknown> {
  if (Object.hasOwn(body, field)) {
    throw invalidRequest({ field, reason: "path_field_not_allowed" });
  }
  return { ...body, [field]: value };
}

function queueFull(
  scope: "global_tool" | "workspace_total" | "workspace_tool",
  retryAfterSeconds: number,
) {
  return new HttpAdapterError({
    status: 429,
    code: "tool_queue_full",
    message: "The tool queue is temporarily at capacity.",
    retryable: true,
    retryAfterSeconds,
    details: { scope },
  });
}

function conflict(
  code: "idempotency_conflict" | "invalid_request",
  reason?: string,
) {
  return new HttpAdapterError({
    status: 409,
    code,
    message: code === "idempotency_conflict"
      ? "The idempotency key was already used for a different request."
      : "The request conflicts with the current resource state.",
    details: reason === undefined ? {} : { reason },
  });
}

export function createV1Routes(
  dependencies: V1RouteDependencies,
): Hono<V1Environment> {
  if (dependencies?.services === undefined) {
    throw new TypeError("services are required");
  }
  if (typeof dependencies.resolveIdentity !== "function") {
    throw new TypeError("resolveIdentity is required");
  }
  const maxJsonBodyBytes = configuredPositiveInteger(
    dependencies.maxJsonBodyBytes,
    DEFAULT_MAX_JSON_BODY_BYTES,
    "maxJsonBodyBytes",
    16 * 1024 * 1024,
  );
  const queueRetryAfterSeconds = configuredPositiveInteger(
    dependencies.queueRetryAfterSeconds,
    DEFAULT_QUEUE_RETRY_AFTER_SECONDS,
    "queueRetryAfterSeconds",
    86_400,
  );
  const routes = new Hono<V1Environment>();

  routes.use("*", async (context, next) => {
    const inherited = context.get("requestId");
    const requestId = typeof inherited === "string" &&
        REQUEST_ID_PATTERN.test(inherited)
      ? inherited
      : createRequestId(dependencies.createRequestId);
    context.set("requestId", requestId);
    context.header("x-request-id", requestId);
    context.header("cache-control", "no-store");
    context.header("x-content-type-options", "nosniff");
    await next();
  });

  routes.onError((error, context) =>
    errorResponse(
      context,
      error instanceof InvalidCursorError
        ? invalidRequest({ field: "cursor", reason: "invalid_cursor" })
        : error,
      context.get("requestId"),
    )
  );

  routes.get(HTTP_PATHS.tools, async (context) => {
    const identity = await requireWorkspaceIdentity(
      dependencies.resolveIdentity,
      context.req.raw,
    );
    const request = parseQuery(
      context.req.raw,
      listToolsRequestSchema,
      {
        cursor: "string",
        limit: "integer",
        category: "string",
        search: "string",
      },
    );
    const result = listToolsResultSchema.parse(
      await dependencies.services.tools.list(identity, request),
    );
    if (result.kind === "not_found") throw notFound();
    return context.json(result);
  });

  routes.get(V1_ADAPTER_PATHS.tool, async (context) => {
    assertNoQuery(context.req.raw);
    const identity = await requireWorkspaceIdentity(
      dependencies.resolveIdentity,
      context.req.raw,
    );
    const toolKey = requireToolKey(context.req.param("toolKey"));
    const result = getToolResultSchema.parse(
      await dependencies.services.tools.get(identity, toolKey),
    );
    if (result.kind === "not_found") throw notFound();
    return context.json(result);
  });

  routes.post(HTTP_PATHS.runs, async (context) => {
    assertNoQuery(context.req.raw);
    const identity = await requireWorkspaceIdentity(
      dependencies.resolveIdentity,
      context.req.raw,
    );
    const idempotencyKey = requireIdempotencyKey(context.req.raw);
    const request = parseContractInput(
      createRunRequestSchema,
      await readJsonBody(context.req.raw, maxJsonBodyBytes),
    );
    const result = createRunResultSchema.parse(
      await dependencies.services.runs.create(
        identity,
        request,
        idempotencyKey,
      ),
    );
    switch (result.kind) {
      case "accepted":
        context.header("location", runPath(result.run.id));
        return context.json(result, 202);
      case "not_found":
        throw notFound();
      case "tool_unavailable":
        throw new HttpAdapterError({
          status: 409,
          code: "tool_unavailable",
          message: "The requested tool is not currently available.",
          details: { toolKey: request.toolKey, reason: "unavailable" },
        });
      case "idempotency_conflict":
        throw conflict("idempotency_conflict");
      case "not_entitled":
        throw new HttpAdapterError({
          status: 403,
          code: "not_entitled",
          message: "The workspace is not entitled to use this tool.",
        });
      case "allowance_exceeded":
        throw new HttpAdapterError({
          status: 429,
          code: "allowance_exceeded",
          message: "The workspace usage allowance has been exceeded.",
          details: {
            metric: result.metric,
            unit: result.unit,
            limitAmount: result.limitAmount,
            consumedAmount: result.consumedAmount,
            reservedAmount: result.reservedAmount,
            requestedAmount: result.requestedAmount,
          },
        });
      case "usage_unavailable":
        throw new HttpAdapterError({
          status: 503,
          code: "dependency_unavailable",
          message: "Usage admission is temporarily unavailable.",
          retryable: true,
          details: { dependency: "metering" },
        });
      case "queue_full":
        throw queueFull(result.scope, queueRetryAfterSeconds);
    }
  });

  routes.get(HTTP_PATHS.runs, async (context) => {
    const identity = await requireWorkspaceIdentity(
      dependencies.resolveIdentity,
      context.req.raw,
    );
    const request = parseQuery(
      context.req.raw,
      listRunsRequestSchema,
      {
        cursor: "string",
        limit: "integer",
        statuses: "strings",
        toolKey: "string",
        acceptedAfter: "string",
        acceptedBefore: "string",
      },
    );
    const result = listRunsResultSchema.parse(
      await dependencies.services.runs.list(identity, request),
    );
    if (result.kind === "not_found") throw notFound();
    return context.json(result);
  });

  routes.get(HTTP_PATHS.run, async (context) => {
    assertNoQuery(context.req.raw);
    const identity = await requireWorkspaceIdentity(
      dependencies.resolveIdentity,
      context.req.raw,
    );
    const runId = requireResourceId(
      context.req.param("runId"),
      PUBLIC_ID_PATTERNS.run,
    );
    const result = getRunResultSchema.parse(
      await dependencies.services.runs.get(identity, runId),
    );
    if (result.kind === "not_found") throw notFound();
    return context.json(result);
  });

  routes.post(HTTP_PATHS.runCancel, async (context) => {
    assertNoQuery(context.req.raw);
    const identity = await requireWorkspaceIdentity(
      dependencies.resolveIdentity,
      context.req.raw,
    );
    await assertEmptyBody(context.req.raw);
    const runId = requireResourceId(
      context.req.param("runId"),
      PUBLIC_ID_PATTERNS.run,
    );
    const result = cancelRunResultSchema.parse(
      await dependencies.services.runs.cancel(identity, runId),
    );
    if (result.kind === "not_found") throw notFound();
    return context.json(result, result.kind === "cancel_requested" ? 202 : 200);
  });

  routes.get(HTTP_PATHS.artifacts, async (context) => {
    const identity = await requireWorkspaceIdentity(
      dependencies.resolveIdentity,
      context.req.raw,
    );
    const request = parseQuery(
      context.req.raw,
      listArtifactsRequestSchema,
      {
        cursor: "string",
        limit: "integer",
        mediaKind: "string",
        sourceRunId: "string",
        shared: "boolean",
        search: "string",
      },
    );
    const result = listArtifactsResultSchema.parse(
      await dependencies.services.artifacts.list(identity, request),
    );
    if (result.kind === "not_found") throw notFound();
    return context.json(result);
  });

  routes.get(HTTP_PATHS.artifact, async (context) => {
    assertNoQuery(context.req.raw);
    const identity = await requireWorkspaceIdentity(
      dependencies.resolveIdentity,
      context.req.raw,
    );
    const artifactId = requireResourceId(
      context.req.param("artifactId"),
      PUBLIC_ID_PATTERNS.artifact,
    );
    const result = getArtifactResultSchema.parse(
      await dependencies.services.artifacts.get(identity, artifactId),
    );
    if (result.kind === "not_found") throw notFound();
    return context.json(result);
  });

  routes.post(V1_ADAPTER_PATHS.artifactDownload, async (context) => {
    assertNoQuery(context.req.raw);
    const identity = await requireWorkspaceIdentity(
      dependencies.resolveIdentity,
      context.req.raw,
    );
    const artifactId = requireResourceId(
      context.req.param("artifactId"),
      PUBLIC_ID_PATTERNS.artifact,
    );
    const body = await readOptionalJsonObject(
      context.req.raw,
      maxJsonBodyBytes,
    );
    const request = parseContractInput(
      createArtifactDownloadRequestSchema,
      bindPathField(body, "artifactId", artifactId),
    );
    const result = createArtifactDownloadResultSchema.parse(
      await dependencies.services.artifacts.createDownload(identity, request),
    );
    if (result.kind === "not_found") throw notFound();
    return context.json(result);
  });

  routes.post(HTTP_PATHS.artifactUploads, async (context) => {
    assertNoQuery(context.req.raw);
    const identity = await requireWorkspaceIdentity(
      dependencies.resolveIdentity,
      context.req.raw,
    );
    const idempotencyKey = requireIdempotencyKey(context.req.raw);
    const request = parseContractInput(
      createArtifactUploadRequestSchema,
      await readJsonBody(context.req.raw, maxJsonBodyBytes),
    );
    const result = createArtifactUploadResultSchema.parse(
      await dependencies.services.artifacts.createUpload(
        identity,
        request,
        idempotencyKey,
      ),
    );
    switch (result.kind) {
      case "created":
        return context.json(result, 201);
      case "not_found":
        throw notFound();
      case "quota_exceeded":
        throw new HttpAdapterError({
          status: 403,
          code: "upload_quota_exceeded",
          message: "The workspace upload quota has been exceeded.",
        });
      case "idempotency_conflict":
        throw conflict("idempotency_conflict");
    }
  });

  routes.post(HTTP_PATHS.artifactUploadComplete, async (context) => {
    assertNoQuery(context.req.raw);
    const identity = await requireWorkspaceIdentity(
      dependencies.resolveIdentity,
      context.req.raw,
    );
    const idempotencyKey = requireIdempotencyKey(context.req.raw);
    await assertEmptyBody(context.req.raw);
    const uploadId = requireResourceId(
      context.req.param("uploadId"),
      PUBLIC_ID_PATTERNS.artifactUpload,
    );
    const result = completeArtifactUploadResultSchema.parse(
      await dependencies.services.artifacts.completeUpload(
        identity,
        uploadId,
        idempotencyKey,
      ),
    );
    switch (result.kind) {
      case "completed":
        return context.json(result);
      case "pending":
        return context.json(result, 202);
      case "verification_failed":
        throw new HttpAdapterError({
          status: 422,
          code: "upload_verification_failed",
          message: "The uploaded object failed verification.",
          details: { reason: result.reason },
        });
      case "expired":
      case "not_found":
        throw notFound();
      case "idempotency_conflict":
        throw conflict("idempotency_conflict");
    }
  });

  routes.post(HTTP_PATHS.artifactShareLinks, async (context) => {
    assertNoQuery(context.req.raw);
    const identity = await requireWorkspaceIdentity(
      dependencies.resolveIdentity,
      context.req.raw,
    );
    const idempotencyKey = requireIdempotencyKey(context.req.raw);
    const artifactId = requireResourceId(
      context.req.param("artifactId"),
      PUBLIC_ID_PATTERNS.artifact,
    );
    const body = await readJsonBody(context.req.raw, maxJsonBodyBytes);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw invalidRequest({ field: "$input", reason: "invalid_type" });
    }
    const request = parseContractInput(
      createShareLinkRequestSchema,
      bindPathField(body as Record<string, unknown>, "artifactId", artifactId),
    );
    const result = createShareLinkResultSchema.parse(
      await dependencies.services.artifacts.createShareLink(
        identity,
        request,
        idempotencyKey,
      ),
    );
    switch (result.kind) {
      case "created":
        context.header("location", result.publicPath);
        return context.json(result, 201);
      case "not_found":
        throw notFound();
      case "conflict":
        throw conflict("invalid_request", "share_policy_conflict");
      case "idempotency_conflict":
        throw conflict("idempotency_conflict");
    }
  });

  routes.delete(HTTP_PATHS.artifactShareLink, async (context) => {
    assertNoQuery(context.req.raw);
    const identity = await requireWorkspaceIdentity(
      dependencies.resolveIdentity,
      context.req.raw,
    );
    const idempotencyKey = requireIdempotencyKey(context.req.raw);
    await assertEmptyBody(context.req.raw);
    const artifactId = requireResourceId(
      context.req.param("artifactId"),
      PUBLIC_ID_PATTERNS.artifact,
    );
    const shareLinkId = requireResourceId(
      context.req.param("shareLinkId"),
      PUBLIC_ID_PATTERNS.shareLink,
    );
    const result = revokeShareLinkResultSchema.parse(
      await dependencies.services.artifacts.revokeShareLink(
        identity,
        artifactId,
        shareLinkId,
        idempotencyKey,
      ),
    );
    if (result.kind === "not_found") throw notFound();
    if (result.kind === "idempotency_conflict") {
      throw conflict("idempotency_conflict");
    }
    return context.json(result);
  });

  routes.get(HTTP_PATHS.usage, async (context) => {
    const identity = await requireWorkspaceIdentity(
      dependencies.resolveIdentity,
      context.req.raw,
    );
    const request = parseQuery(
      context.req.raw,
      usageSummaryRequestSchema,
      { metric: "string", period: "string" },
    );
    const result = getUsageSummaryResultSchema.parse(
      await dependencies.services.usage.getSummary(identity, request),
    );
    if (result.kind === "not_found") throw notFound();
    return context.json(result);
  });

  routes.get(HTTP_PATHS.events, async (context) => {
    assertNoQuery(context.req.raw);
    const identity = await requireWorkspaceIdentity(
      dependencies.resolveIdentity,
      context.req.raw,
    );
    return await createWorkspaceEventResponse(context, identity, {
      events: dependencies.services.events,
      resolveIdentity: dependencies.resolveIdentity,
      options: dependencies.eventStream,
    });
  });

  routes.get(HTTP_PATHS.publicShareTemplate, async (context) => {
    assertNoQuery(context.req.raw);
    const actorUserId = await optionalActorUserId(
      dependencies.resolveIdentity,
      context.req.raw,
    );
    const result = resolveShareLinkResultSchema.parse(
      await dependencies.services.artifacts.resolveShareLink(
        context.req.param("token"),
        actorUserId,
      ),
    );
    switch (result.kind) {
      case "authorized":
        if (Object.keys(result.download.requiredHeaders).length !== 0) {
          throw new Error(
            "share redirect requires unsupported request headers",
          );
        }
        context.header("referrer-policy", "no-referrer");
        return context.redirect(result.download.url, 302);
      case "authentication_required":
        throw new HttpAdapterError({
          status: 401,
          code: "authentication_required",
          message: "Authentication is required.",
        });
      case "unavailable":
        throw notFound();
    }
  });

  routes.notFound((context) =>
    errorResponse(context, notFound(), context.get("requestId"))
  );

  return routes;
}
