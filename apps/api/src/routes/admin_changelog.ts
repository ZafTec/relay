import { type Context, Hono, type Next } from "@hono/hono";
import type { Auth } from "@relay/auth";
import {
  type AdminChangelogRelease as ServiceAdminChangelogRelease,
  type AdminChangelogSummary as ServiceAdminChangelogSummary,
  type AdminReadResult,
  type AdminSession,
  assertIdempotencyKey,
  type CreateChangelogDraftResult,
  GovernanceIdempotencyConflictError,
  type GovernanceMutationContext,
  type PublishChangelogResult,
  type ReviseChangelogDraftResult,
  type UnpublishChangelogResult,
} from "@relay/changelog";
import {
  type AdminChangelogDraftInput,
  adminChangelogDraftInputSchema,
  adminChangelogListResponseSchema,
  adminChangelogReleasePath,
  adminChangelogReleaseSchema,
  type CreateAdminChangelogResult,
  createAdminChangelogResultSchema,
  HTTP_PATHS,
  isAdminChangelogReleaseId,
  type ListAdminChangelogRequest,
  listAdminChangelogRequestSchema,
  publishAdminChangelogRequestSchema,
  type PublishAdminChangelogResult,
  publishAdminChangelogResultSchema,
  reviseAdminChangelogRequestSchema,
  type ReviseAdminChangelogResult,
  reviseAdminChangelogResultSchema,
  unpublishAdminChangelogRequestSchema,
  type UnpublishAdminChangelogResult,
  unpublishAdminChangelogResultSchema,
} from "@relay/contracts";
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
import {
  assertNoQuery,
  DEFAULT_MAX_JSON_BODY_BYTES,
  parseContractInput,
  parseQuery,
  readJsonBody,
} from "../http/request.ts";
import {
  createSessionMiddleware,
  type SessionVariables,
} from "../middleware/session.ts";

interface AdminChangelogEnvironment {
  Variables: SessionVariables & {
    requestId: string;
  };
}

export interface AdminChangelogService {
  list(
    session: AdminSession,
    request: ListAdminChangelogRequest,
  ): Promise<AdminReadResult<readonly ServiceAdminChangelogSummary[]>>;
  get(
    session: AdminSession,
    releaseId: string,
  ): Promise<AdminReadResult<ServiceAdminChangelogRelease>>;
  create(
    context: GovernanceMutationContext,
    input: AdminChangelogDraftInput,
  ): Promise<CreateChangelogDraftResult>;
  revise(
    context: GovernanceMutationContext,
    releaseId: string,
    expectedRevision: number,
    input: AdminChangelogDraftInput,
  ): Promise<ReviseChangelogDraftResult>;
  publish(
    context: GovernanceMutationContext,
    releaseId: string,
    expectedRevision: number,
  ): Promise<PublishChangelogResult>;
  unpublish(
    context: GovernanceMutationContext,
    releaseId: string,
    expectedPublishedRevision: number,
  ): Promise<UnpublishChangelogResult>;
}

export interface AdminChangelogRouteDependencies {
  readonly auth: Auth;
  readonly service: AdminChangelogService;
  readonly allowedOrigins: readonly string[];
  readonly maxJsonBodyBytes?: number;
  readonly createRequestId?: () => string;
  readonly onUnexpectedError?: (
    error: unknown,
    requestId: string,
    routePath: string,
  ) => void;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const MAX_CONFIGURED_JSON_BODY_BYTES = 16 * 1024 * 1024;
const ADMIN_ROUTE_SCOPES = [`${HTTP_PATHS.adminChangelog}/*`] as const;

type ParsedAdminReadResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "not_found" }
  | { readonly kind: "denied" }
  | { readonly kind: "reauthentication_required" };

function configuredBodyLimit(value: number | undefined): number {
  const selected = value ?? DEFAULT_MAX_JSON_BODY_BYTES;
  if (
    !Number.isSafeInteger(selected) || selected < 1 ||
    selected > MAX_CONFIGURED_JSON_BODY_BYTES
  ) {
    throw new TypeError("maxJsonBodyBytes must be a positive bounded integer");
  }
  return selected;
}

function parseHttpOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("origin must be an HTTP(S) origin");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" || parsed.password !== "" ||
    parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== ""
  ) {
    throw new TypeError("origin must be an HTTP(S) origin");
  }
  return parsed.origin;
}

function configuredOrigins(values: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("allowedOrigins are required");
  }
  return new Set(values.map((value) => {
    try {
      return parseHttpOrigin(value);
    } catch {
      throw new TypeError("allowedOrigins must contain HTTP(S) origins");
    }
  }));
}

function requestId(
  context: Context<AdminChangelogEnvironment>,
  factory: (() => string) | undefined,
): string {
  const inherited = context.get("requestId");
  if (typeof inherited === "string" && REQUEST_ID_PATTERN.test(inherited)) {
    return inherited;
  }
  try {
    const candidate = factory?.() ?? `req_${crypto.randomUUID()}`;
    if (REQUEST_ID_PATTERN.test(candidate)) return candidate;
  } catch {
    // Correlation is best effort and must not reject an admin request.
  }
  return `req_${crypto.randomUUID()}`;
}

function prepareResponse(
  context: Context<AdminChangelogEnvironment>,
  factory: (() => string) | undefined,
): string {
  const id = requestId(context, factory);
  context.set("requestId", id);
  context.header("x-request-id", id);
  context.header("cache-control", "no-store");
  context.header("x-content-type-options", "nosniff");
  return id;
}

function assertTrustedMutationOrigin(
  request: Request,
  allowedOrigins: ReadonlySet<string>,
): void {
  if (request.method !== "POST" && request.method !== "PATCH") return;
  const value = request.headers.get("origin");
  if (value === null) throw authorizationDenied();

  let origin: string;
  try {
    origin = parseHttpOrigin(value);
  } catch {
    throw authorizationDenied();
  }
  if (origin !== value || !allowedOrigins.has(origin)) {
    throw authorizationDenied();
  }
}

function requireAdminSession(
  context: Context<AdminChangelogEnvironment>,
): AdminSession {
  const current = context.get("session");
  const sessionId = current?.session.id;
  if (
    typeof sessionId !== "string" || sessionId.trim() === "" ||
    sessionId.length > 256
  ) {
    throw authenticationRequired();
  }
  return { sessionId };
}

function requireReleaseId(value: string): string {
  if (!isAdminChangelogReleaseId(value)) {
    throw notFound({ resource: "changelog_release" });
  }
  return value;
}

function requireIdempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key");
  if (value === null) {
    throw invalidRequest({
      field: "idempotency-key",
      reason: "missing_header",
    });
  }
  try {
    assertIdempotencyKey(value);
  } catch {
    throw invalidRequest({
      field: "idempotency-key",
      reason: "invalid_header",
    });
  }
  return value;
}

function mutationContext(
  session: AdminSession,
  idempotencyKey: string,
  requestId: string,
): GovernanceMutationContext {
  return {
    sessionId: session.sessionId,
    idempotencyKey,
    requestId,
  };
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function parseAdminReadResult<T>(
  value: unknown,
  parseValue: (value: unknown) => T,
): ParsedAdminReadResult<T> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("admin changelog service returned an invalid result");
  }
  const result = value as Record<string, unknown>;
  switch (result.kind) {
    case "ok":
      if (!hasExactKeys(result, ["kind", "value"])) {
        throw new TypeError(
          "admin changelog service returned an invalid result",
        );
      }
      return { kind: "ok", value: parseValue(result.value) };
    case "not_found":
    case "denied":
    case "reauthentication_required":
      if (!hasExactKeys(result, ["kind"])) {
        throw new TypeError(
          "admin changelog service returned an invalid result",
        );
      }
      return { kind: result.kind };
    default:
      throw new TypeError("admin changelog service returned an invalid result");
  }
}

function throwReadFailure(
  result: Exclude<ParsedAdminReadResult<unknown>, { readonly kind: "ok" }>,
): never {
  switch (result.kind) {
    case "not_found":
      throw notFound({ resource: "changelog_release" });
    case "denied":
      throw authorizationDenied();
    case "reauthentication_required":
      throw reauthenticationRequired();
  }
}

function conflict(
  reason: string,
  actualRevision?: number,
): HttpAdapterError {
  return new HttpAdapterError({
    status: 409,
    code: "invalid_request",
    message: "The request conflicts with the current changelog release state.",
    details: {
      reason,
      ...(actualRevision === undefined ? {} : { actualRevision }),
    },
  });
}

function mapAuthorizationFailure(
  kind: "denied" | "reauthentication_required",
): never {
  if (kind === "reauthentication_required") {
    throw reauthenticationRequired();
  }
  throw authorizationDenied();
}

function createMiddleware(
  dependencies: AdminChangelogRouteDependencies,
): (context: Context<AdminChangelogEnvironment>, next: Next) => Promise<void> {
  return async (context, next) => {
    prepareResponse(context, dependencies.createRequestId);
    await next();
  };
}

function originMiddleware(
  allowedOrigins: ReadonlySet<string>,
): (context: Context<AdminChangelogEnvironment>, next: Next) => Promise<void> {
  return async (context, next) => {
    assertTrustedMutationOrigin(context.req.raw, allowedOrigins);
    await next();
  };
}

function assertService(service: AdminChangelogService): void {
  if (
    service === undefined || typeof service.list !== "function" ||
    typeof service.get !== "function" || typeof service.create !== "function" ||
    typeof service.revise !== "function" ||
    typeof service.publish !== "function" ||
    typeof service.unpublish !== "function"
  ) {
    throw new TypeError("an admin changelog service is required");
  }
}

export function createAdminChangelogRoutes(
  dependencies: AdminChangelogRouteDependencies,
): Hono<AdminChangelogEnvironment> {
  if (dependencies?.auth === undefined) {
    throw new TypeError("auth is required");
  }
  assertService(dependencies.service);
  const allowedOrigins = configuredOrigins(dependencies.allowedOrigins);
  const maxJsonBodyBytes = configuredBodyLimit(dependencies.maxJsonBodyBytes);
  const routes = new Hono<AdminChangelogEnvironment>();
  const prepare = createMiddleware(dependencies);
  const checkOrigin = originMiddleware(allowedOrigins);
  const session = createSessionMiddleware(dependencies.auth);

  for (const path of ADMIN_ROUTE_SCOPES) {
    routes.use(path, prepare);
    routes.use(path, checkOrigin);
    routes.use(path, session);
  }

  routes.onError((error, context) => {
    const id = prepareResponse(context, dependencies.createRequestId);
    const mapped = error instanceof GovernanceIdempotencyConflictError
      ? idempotencyConflict()
      : error;
    if (!(mapped instanceof HttpAdapterError)) {
      try {
        dependencies.onUnexpectedError?.(error, id, context.req.routePath);
      } catch {
        // Error reporting is best effort and must not replace the response.
      }
    }
    return errorResponse(context, mapped, id);
  });

  routes.get(HTTP_PATHS.adminChangelog, async (context) => {
    const session = requireAdminSession(context);
    const request = parseQuery(
      context.req.raw,
      listAdminChangelogRequestSchema,
      { limit: "integer", beforeReleaseId: "string" },
    );
    const result = parseAdminReadResult(
      await dependencies.service.list(session, request),
      (releases) => adminChangelogListResponseSchema.parse({ releases }),
    );
    if (result.kind !== "ok") throwReadFailure(result);
    return context.json(result.value);
  });

  routes.post(HTTP_PATHS.adminChangelog, async (context) => {
    assertNoQuery(context.req.raw);
    const session = requireAdminSession(context);
    const idempotencyKey = requireIdempotencyKey(context.req.raw);
    const input = parseContractInput(
      adminChangelogDraftInputSchema,
      await readJsonBody(context.req.raw, maxJsonBodyBytes),
    );
    const result: CreateAdminChangelogResult = createAdminChangelogResultSchema
      .parse(
        await dependencies.service.create(
          mutationContext(session, idempotencyKey, context.get("requestId")),
          input,
        ),
      );
    switch (result.kind) {
      case "created":
        context.header(
          "location",
          adminChangelogReleasePath(result.releaseId),
        );
        return context.json(result, 201);
      case "conflict":
        throw conflict(result.reason);
      case "denied":
      case "reauthentication_required":
        return mapAuthorizationFailure(result.kind);
    }
  });

  routes.get(HTTP_PATHS.adminChangelogRelease, async (context) => {
    assertNoQuery(context.req.raw);
    const session = requireAdminSession(context);
    const releaseId = requireReleaseId(context.req.param("releaseId"));
    const result = parseAdminReadResult(
      await dependencies.service.get(session, releaseId),
      (release) => adminChangelogReleaseSchema.parse(release),
    );
    if (result.kind !== "ok") throwReadFailure(result);
    return context.json(result.value);
  });

  routes.patch(HTTP_PATHS.adminChangelogRelease, async (context) => {
    assertNoQuery(context.req.raw);
    const session = requireAdminSession(context);
    const releaseId = requireReleaseId(context.req.param("releaseId"));
    const idempotencyKey = requireIdempotencyKey(context.req.raw);
    const request = parseContractInput(
      reviseAdminChangelogRequestSchema,
      await readJsonBody(context.req.raw, maxJsonBodyBytes),
    );
    const { expectedRevision, ...input } = request;
    const result: ReviseAdminChangelogResult = reviseAdminChangelogResultSchema
      .parse(
        await dependencies.service.revise(
          mutationContext(session, idempotencyKey, context.get("requestId")),
          releaseId,
          expectedRevision,
          input,
        ),
      );
    switch (result.kind) {
      case "revised":
      case "unchanged":
        return context.json(result);
      case "not_found":
        throw notFound({ resource: "changelog_release" });
      case "revision_conflict":
        throw conflict("revision_conflict", result.actualRevision);
      case "identity_locked":
        throw conflict("identity_locked", result.revision);
      case "conflict":
        throw conflict(result.reason);
      case "denied":
      case "reauthentication_required":
        return mapAuthorizationFailure(result.kind);
    }
  });

  routes.post(HTTP_PATHS.adminChangelogPublish, async (context) => {
    assertNoQuery(context.req.raw);
    const session = requireAdminSession(context);
    const releaseId = requireReleaseId(context.req.param("releaseId"));
    const idempotencyKey = requireIdempotencyKey(context.req.raw);
    const request = parseContractInput(
      publishAdminChangelogRequestSchema,
      await readJsonBody(context.req.raw, maxJsonBodyBytes),
    );
    const result: PublishAdminChangelogResult =
      publishAdminChangelogResultSchema
        .parse(
          await dependencies.service.publish(
            mutationContext(session, idempotencyKey, context.get("requestId")),
            releaseId,
            request.expectedRevision,
          ),
        );
    switch (result.kind) {
      case "published":
      case "superseded":
      case "unchanged":
        return context.json(result);
      case "not_found":
        throw notFound({ resource: "changelog_release" });
      case "revision_conflict":
        throw conflict("revision_conflict", result.actualRevision);
      case "not_publishable":
        throw invalidRequest(
          { reason: "not_publishable", reasons: result.reasons },
          422,
        );
      case "denied":
      case "reauthentication_required":
        return mapAuthorizationFailure(result.kind);
    }
  });

  routes.post(HTTP_PATHS.adminChangelogUnpublish, async (context) => {
    assertNoQuery(context.req.raw);
    const session = requireAdminSession(context);
    const releaseId = requireReleaseId(context.req.param("releaseId"));
    const idempotencyKey = requireIdempotencyKey(context.req.raw);
    const request = parseContractInput(
      unpublishAdminChangelogRequestSchema,
      await readJsonBody(context.req.raw, maxJsonBodyBytes),
    );
    const result: UnpublishAdminChangelogResult =
      unpublishAdminChangelogResultSchema.parse(
        await dependencies.service.unpublish(
          mutationContext(session, idempotencyKey, context.get("requestId")),
          releaseId,
          request.expectedPublishedRevision,
        ),
      );
    switch (result.kind) {
      case "unpublished":
      case "unchanged":
        return context.json(result);
      case "not_found":
        throw notFound({ resource: "changelog_release" });
      case "revision_conflict":
        throw conflict("revision_conflict", result.actualRevision);
      case "denied":
      case "reauthentication_required":
        return mapAuthorizationFailure(result.kind);
    }
  });

  const adminNotFound = (context: Context<AdminChangelogEnvironment>) =>
    errorResponse(
      context,
      notFound({ resource: "changelog_release" }),
      prepareResponse(context, dependencies.createRequestId),
    );
  routes.all(HTTP_PATHS.adminChangelog, adminNotFound);
  routes.all(`${HTTP_PATHS.adminChangelog}/*`, adminNotFound);

  return routes;
}
