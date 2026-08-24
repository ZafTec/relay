import { createMutationArtifacts } from "./crypto.ts";
import {
  authorizationFailure,
  databaseErrorCode,
  throwMappedMutationError,
} from "./errors.ts";
import {
  type LegalDocumentRow,
  mapLegalDocument,
  mutationResult,
} from "./mapping.ts";
import type {
  AcceptLegalDocumentInput,
  AcceptLegalDocumentResult,
  AdminReadResult,
  AdminSession,
  CreateLegalDocumentResult,
  GovernanceMutationContext,
  LegalAcceptanceContext,
  LegalDocument,
  LegalDocumentInput,
  PublishLegalDocumentResult,
  Queryable,
  ReviseLegalDocumentResult,
  UnpublishLegalDocumentResult,
} from "./types.ts";
import {
  assertDocumentType,
  assertSessionId,
  assertSha256,
  normalizeLegalDocument,
  normalizeMutationContext,
  optionalBoundedText,
  positiveIntegerString,
  positiveRevision,
} from "./validation.ts";

async function mutateLegal<T extends { readonly kind: string }>(
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
    `legal_document.${operation}`,
    normalizedContext.idempotencyKey,
    payload,
  );
  try {
    const { rows } = await db.query<{ result: unknown }>(
      `select relay.mutate_legal_document(
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

export async function createLegalDocumentDraft(
  db: Queryable,
  context: GovernanceMutationContext,
  input: LegalDocumentInput,
): Promise<CreateLegalDocumentResult> {
  return await mutateLegal<CreateLegalDocumentResult>(
    db,
    "create",
    context,
    { ...normalizeLegalDocument(input) },
  ) as CreateLegalDocumentResult;
}

export async function reviseLegalDocumentDraft(
  db: Queryable,
  context: GovernanceMutationContext,
  expectedRevision: number,
  input: LegalDocumentInput,
): Promise<ReviseLegalDocumentResult> {
  positiveRevision(expectedRevision, "expectedRevision");
  return await mutateLegal<ReviseLegalDocumentResult>(
    db,
    "revise",
    context,
    { expectedRevision, ...normalizeLegalDocument(input) },
  ) as ReviseLegalDocumentResult;
}

export async function publishLegalDocument(
  db: Queryable,
  context: GovernanceMutationContext,
  documentId: string,
): Promise<PublishLegalDocumentResult> {
  positiveIntegerString(documentId, "documentId");
  return await mutateLegal<PublishLegalDocumentResult>(
    db,
    "publish",
    context,
    { documentId },
  ) as PublishLegalDocumentResult;
}

export async function unpublishLegalDocument(
  db: Queryable,
  context: GovernanceMutationContext,
  documentType: string,
  expectedDocumentId: string,
): Promise<UnpublishLegalDocumentResult> {
  assertDocumentType(documentType);
  positiveIntegerString(expectedDocumentId, "expectedDocumentId");
  return await mutateLegal<UnpublishLegalDocumentResult>(
    db,
    "unpublish",
    context,
    { documentType, expectedDocumentId },
  ) as UnpublishLegalDocumentResult;
}

export async function listAdminLegalDocuments(
  db: Queryable,
  session: AdminSession,
  documentType?: string | null,
): Promise<AdminReadResult<readonly LegalDocument[]>> {
  assertSessionId(session.sessionId);
  if (documentType !== undefined && documentType !== null) {
    assertDocumentType(documentType);
  }
  try {
    const { rows } = await db.query<LegalDocumentRow>(
      `select document_id, document_type, version, revision, effective_at,
              canonical_url, content_sha256, requires_acceptance,
              acceptance_scope, record_sha256, published_at
         from relay.list_admin_legal_documents($1, $2)`,
      [session.sessionId, documentType ?? null],
    );
    return { kind: "ok", value: rows.map(mapLegalDocument) };
  } catch (error) {
    const code = databaseErrorCode(error);
    if (code === "28000" || code === "55000") {
      return { kind: "reauthentication_required" };
    }
    if (code === "42501") return { kind: "denied" };
    throw error;
  }
}

/** Public metadata only; document text stays at the operator-provided URL. */
export async function listPublishedLegalDocuments(
  db: Queryable,
): Promise<readonly LegalDocument[]> {
  const { rows } = await db.query<LegalDocumentRow>(
    `select document_id, document_type, version, revision, effective_at,
            canonical_url, content_sha256, requires_acceptance,
            acceptance_scope, record_sha256, published_at
       from relay.list_public_legal_documents()`,
  );
  return rows.map(mapLegalDocument);
}

export async function listPendingLegalDocuments(
  db: Queryable,
  session: AdminSession,
  workspaceId?: string | null,
): Promise<AdminReadResult<readonly LegalDocument[]>> {
  assertSessionId(session.sessionId);
  const normalizedWorkspaceId = optionalBoundedText(
    workspaceId,
    "workspaceId",
    256,
  );
  try {
    const { rows } = await db.query<LegalDocumentRow>(
      `select document_id, document_type, version, revision, effective_at,
              canonical_url, content_sha256, requires_acceptance,
              acceptance_scope, record_sha256, published_at
         from relay.list_pending_legal_documents($1, $2)`,
      [session.sessionId, normalizedWorkspaceId],
    );
    return { kind: "ok", value: rows.map(mapLegalDocument) };
  } catch (error) {
    const code = databaseErrorCode(error);
    if (code === "28000") return { kind: "reauthentication_required" };
    if (code === "42501") return { kind: "denied" };
    throw error;
  }
}

export async function acceptLegalDocument(
  db: Queryable,
  context: LegalAcceptanceContext,
  input: AcceptLegalDocumentInput,
): Promise<AcceptLegalDocumentResult> {
  assertSessionId(context.sessionId);
  assertDocumentType(input.documentType);
  if (input.version.trim() === "" || input.version.length > 128) {
    throw new TypeError("version must contain 1-128 characters");
  }
  positiveRevision(input.revision);
  assertSha256(input.contentSha256);
  if (
    input.acceptanceScope !== "user" && input.acceptanceScope !== "workspace"
  ) {
    throw new TypeError("acceptanceScope must be user or workspace");
  }
  const workspaceId = input.acceptanceScope === "workspace"
    ? optionalBoundedText(input.workspaceId, "workspaceId", 256)
    : null;
  if (
    input.acceptanceScope === "workspace" &&
    (workspaceId === null || workspaceId.trim() === "")
  ) {
    throw new TypeError(
      "workspaceId must not be empty for workspace acceptance",
    );
  }
  const ipAddress = optionalBoundedText(context.ipAddress, "ipAddress", 64);
  const userAgent = optionalBoundedText(
    context.userAgent,
    "userAgent",
    1_024,
  );
  const requestId = optionalBoundedText(context.requestId, "requestId", 256);
  const traceId = optionalBoundedText(context.traceId, "traceId", 256);
  try {
    const { rows } = await db.query<{ result: unknown }>(
      `select relay.accept_legal_document(
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
       ) as result`,
      [
        context.sessionId,
        input.acceptanceScope,
        workspaceId,
        input.documentType,
        input.version,
        input.revision,
        input.contentSha256,
        ipAddress,
        userAgent,
        requestId,
        traceId,
      ],
    );
    return mutationResult<AcceptLegalDocumentResult>(rows[0]?.result);
  } catch (error) {
    const code = databaseErrorCode(error);
    if (code === "28000") return { kind: "unauthenticated", replayed: false };
    if (code === "42501") return { kind: "denied", replayed: false };
    throw error;
  }
}
