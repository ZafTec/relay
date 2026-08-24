import { createMutationArtifacts } from "./crypto.ts";
import {
  authorizationFailure,
  databaseErrorCode,
  throwMappedMutationError,
} from "./errors.ts";
import {
  type AdminRevisionRow,
  type AdminSummaryRow,
  mapAdminRelease,
  mapAdminRevision,
  mapAdminSummary,
  mutationResult,
} from "./mapping.ts";
import type {
  AdminChangelogRelease,
  AdminChangelogRevision,
  AdminChangelogSummary,
  AdminReadResult,
  AdminSession,
  ChangelogDraftInput,
  CreateChangelogDraftResult,
  GovernanceMutationContext,
  PublishChangelogResult,
  Queryable,
  ReviseChangelogDraftResult,
  UnpublishChangelogResult,
} from "./types.ts";
import {
  assertSessionId,
  normalizeChangelogDraft,
  normalizeMutationContext,
  pageLimit,
  positiveIntegerString,
  positiveRevision,
} from "./validation.ts";

async function mutate<T extends { readonly kind: string }>(
  db: Queryable,
  operation: "create" | "revise" | "publish" | "unpublish",
  context: GovernanceMutationContext,
  payload: Record<string, unknown>,
): Promise<
  T | { readonly kind: "denied"; readonly replayed: false } | {
    readonly kind: "reauthentication_required";
    readonly replayed: false;
  }
> {
  const normalizedContext = normalizeMutationContext(context);
  const artifacts = await createMutationArtifacts(
    `changelog.${operation}`,
    normalizedContext.idempotencyKey,
    payload,
  );
  try {
    const { rows } = await db.query<{ result: unknown }>(
      `select relay.mutate_changelog(
         $1, $2, $3, $4::jsonb, $5, $6
       ) as result`,
      [
        operation,
        normalizedContext.sessionId,
        artifacts.keyHash,
        JSON.stringify(payload),
        normalizedContext.requestId,
        normalizedContext.traceId,
      ],
    );
    return mutationResult<T>(rows[0]?.result);
  } catch (error) {
    const failure = authorizationFailure(error);
    if (failure !== undefined) return failure;
    throwMappedMutationError(error);
  }
}

export async function createChangelogDraft(
  db: Queryable,
  context: GovernanceMutationContext,
  input: ChangelogDraftInput,
): Promise<CreateChangelogDraftResult> {
  const payload = normalizeChangelogDraft(input);
  return await mutate<CreateChangelogDraftResult>(
    db,
    "create",
    context,
    { ...payload },
  ) as CreateChangelogDraftResult;
}

export async function reviseChangelogDraft(
  db: Queryable,
  context: GovernanceMutationContext,
  releaseId: string,
  expectedRevision: number,
  input: ChangelogDraftInput,
): Promise<ReviseChangelogDraftResult> {
  positiveIntegerString(releaseId, "releaseId");
  positiveRevision(expectedRevision, "expectedRevision");
  const payload = {
    releaseId,
    expectedRevision,
    ...normalizeChangelogDraft(input),
  };
  return await mutate<ReviseChangelogDraftResult>(
    db,
    "revise",
    context,
    payload,
  ) as ReviseChangelogDraftResult;
}

export async function publishChangelogRelease(
  db: Queryable,
  context: GovernanceMutationContext,
  releaseId: string,
  expectedRevision: number,
): Promise<PublishChangelogResult> {
  positiveIntegerString(releaseId, "releaseId");
  positiveRevision(expectedRevision, "expectedRevision");
  return await mutate<PublishChangelogResult>(db, "publish", context, {
    releaseId,
    expectedRevision,
  }) as PublishChangelogResult;
}

export async function unpublishChangelogRelease(
  db: Queryable,
  context: GovernanceMutationContext,
  releaseId: string,
  expectedPublishedRevision: number,
): Promise<UnpublishChangelogResult> {
  positiveIntegerString(releaseId, "releaseId");
  positiveRevision(expectedPublishedRevision, "expectedPublishedRevision");
  return await mutate<UnpublishChangelogResult>(db, "unpublish", context, {
    releaseId,
    expectedPublishedRevision,
  }) as UnpublishChangelogResult;
}

function mapAdminReadError<T>(error: unknown): AdminReadResult<T> | undefined {
  const code = databaseErrorCode(error);
  if (code === "42501") return { kind: "denied" };
  if (code === "28000" || code === "55000") {
    return { kind: "reauthentication_required" };
  }
  return undefined;
}

export async function listAdminChangelog(
  db: Queryable,
  session: AdminSession,
  options: {
    readonly limit?: number;
    readonly beforeReleaseId?: string | null;
  } = {},
): Promise<AdminReadResult<readonly AdminChangelogSummary[]>> {
  assertSessionId(session.sessionId);
  const limit = pageLimit(options.limit);
  const beforeReleaseId = options.beforeReleaseId === undefined ||
      options.beforeReleaseId === null
    ? null
    : positiveIntegerString(options.beforeReleaseId, "beforeReleaseId");
  try {
    const { rows } = await db.query<AdminSummaryRow>(
      `select release_id, version, slug, status, latest_revision,
              published_revision, has_unpublished_changes, updated_at
         from relay.list_admin_changelog($1, $2, $3::bigint)`,
      [session.sessionId, limit, beforeReleaseId],
    );
    return { kind: "ok", value: rows.map(mapAdminSummary) };
  } catch (error) {
    const mapped = mapAdminReadError<readonly AdminChangelogSummary[]>(error);
    if (mapped !== undefined) return mapped;
    throw error;
  }
}

export async function getAdminChangelogRelease(
  db: Queryable,
  session: AdminSession,
  releaseId: string,
): Promise<AdminReadResult<AdminChangelogRelease>> {
  assertSessionId(session.sessionId);
  positiveIntegerString(releaseId, "releaseId");
  try {
    const { rows } = await db.query<{ result: unknown }>(
      "select relay.get_admin_changelog($1, $2::bigint) as result",
      [session.sessionId, releaseId],
    );
    if (rows[0]?.result === null || rows[0] === undefined) {
      return { kind: "not_found" };
    }
    return { kind: "ok", value: mapAdminRelease(rows[0].result) };
  } catch (error) {
    const mapped = mapAdminReadError<AdminChangelogRelease>(error);
    if (mapped !== undefined) return mapped;
    throw error;
  }
}

export async function listChangelogRevisions(
  db: Queryable,
  session: AdminSession,
  releaseId: string,
): Promise<AdminReadResult<readonly AdminChangelogRevision[]>> {
  assertSessionId(session.sessionId);
  positiveIntegerString(releaseId, "releaseId");
  try {
    const { rows } = await db.query<AdminRevisionRow>(
      `select revision, snapshot, changed_by, changed_at
         from relay.list_admin_changelog_revisions($1, $2::bigint)`,
      [session.sessionId, releaseId],
    );
    return { kind: "ok", value: rows.map(mapAdminRevision) };
  } catch (error) {
    const mapped = mapAdminReadError<readonly AdminChangelogRevision[]>(error);
    if (mapped !== undefined) return mapped;
    throw error;
  }
}
