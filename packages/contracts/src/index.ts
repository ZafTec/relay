export { generatePublicId, ID_PREFIXES } from "./ids.ts";
export type { IdPrefix } from "./ids.ts";

export {
  JOB_STATUSES,
  RUN_RESULT_COMPLETENESS,
  RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
} from "./statuses.ts";
export type {
  JobStatus,
  RunResultCompleteness,
  RunStatus,
  TerminalRunStatus,
} from "./statuses.ts";

export { ContractValidationError, defineContractSchema } from "./schema.ts";
export type {
  ContractParseResult,
  ContractSchema,
  ContractValidationCode,
  ContractValidationIssue,
  JsonObject,
  JsonPrimitive,
  JsonSchema,
  JsonValue,
} from "./schema.ts";

export {
  adminChangelogReleasePath,
  changelogEntryPath,
  HTTP_PATHS,
  PUBLIC_NOUNS,
  publicSharePath,
  runPath,
} from "./routes.ts";

export {
  adminChangelogDraftInputSchema,
  adminChangelogListResponseSchema,
  adminChangelogReleaseSchema,
  adminChangelogRevisionSchema,
  adminChangelogSummarySchema,
  CHANGELOG_CATEGORIES,
  CHANGELOG_CONFLICT_REASONS,
  CHANGELOG_PUBLISHABILITY_REASONS,
  CHANGELOG_RELEASE_STATUSES,
  createAdminChangelogResultSchema,
  isAdminChangelogReleaseId,
  listAdminChangelogRequestSchema,
  publishAdminChangelogRequestSchema,
  publishAdminChangelogResultSchema,
  reviseAdminChangelogRequestSchema,
  reviseAdminChangelogResultSchema,
  unpublishAdminChangelogRequestSchema,
  unpublishAdminChangelogResultSchema,
} from "./changelog.ts";
export type {
  AdminChangelogDraftInput,
  AdminChangelogItemInput,
  AdminChangelogListResponse,
  AdminChangelogRelease,
  AdminChangelogRevision,
  AdminChangelogSummary,
  CreateAdminChangelogResult,
  ListAdminChangelogRequest,
  PublishAdminChangelogRequest,
  PublishAdminChangelogResult,
  ReviseAdminChangelogRequest,
  ReviseAdminChangelogResult,
  UnpublishAdminChangelogRequest,
  UnpublishAdminChangelogResult,
} from "./changelog.ts";

export {
  createCursorPageSchema,
  cursorPaginationRequestSchema,
  DEFAULT_PAGE_SIZE,
  MAX_CURSOR_LENGTH,
  MAX_PAGE_SIZE,
} from "./pagination.ts";
export type { CursorPage, CursorPaginationRequest } from "./pagination.ts";

export {
  DECIMAL_AMOUNT_PATTERN,
  PUBLIC_ID_PATTERNS,
  SAFE_CODE_PATTERN,
  TOOL_KEY_PATTERN,
} from "./identifiers.ts";
export type { PublicIdKind } from "./identifiers.ts";

export {
  ERROR_CODES,
  errorEnvelopeSchema,
  publicErrorSchema,
} from "./errors.ts";
export type {
  ErrorCode,
  ErrorEnvelope,
  PublicError,
  PublicErrorDetails,
} from "./errors.ts";

export {
  getToolResultSchema,
  listToolsRequestSchema,
  listToolsResultSchema,
  PUBLIC_TOOL_LIFECYCLES,
  toolDetailSchema,
  toolSummarySchema,
} from "./tools.ts";
export type {
  GetToolResult,
  ListToolsRequest,
  ListToolsResult,
  PublicToolLifecycle,
  ToolDetail,
  ToolSummary,
} from "./tools.ts";

export {
  cancelRunResultSchema,
  createRunRequestSchema,
  createRunResultSchema,
  getRunResultSchema,
  listRunsRequestSchema,
  listRunsResultSchema,
  RUN_QUEUE_REASONS,
  RUN_USAGE_UNAVAILABLE_REASONS,
  runDetailSchema,
  runOutputItemSchema,
  runOutputSetSchema,
  runReservationSummarySchema,
  runSummarySchema,
} from "./runs.ts";
export type {
  CancelRunResult,
  CreateRunRequest,
  CreateRunResult,
  GetRunResult,
  ListRunsRequest,
  ListRunsResult,
  RunDetail,
  RunOutputItem,
  RunOutputSet,
  RunQueueReason,
  RunReservationSummary,
  RunSummary,
  RunToolReference,
  RunUsageUnavailableReason,
} from "./runs.ts";

export {
  ARTIFACT_UPLOAD_STATUSES,
  ARTIFACT_VERIFICATION_STATUSES,
  ARTIFACT_VERSION_SOURCES,
  artifactDetailSchema,
  artifactSummarySchema,
  artifactUploadSchema,
  artifactVersionSchema,
  completeArtifactUploadResultSchema,
  createArtifactDownloadRequestSchema,
  createArtifactDownloadResultSchema,
  createArtifactUploadRequestSchema,
  createArtifactUploadResultSchema,
  createShareLinkRequestSchema,
  createShareLinkResultSchema,
  downloadAuthorizationSchema,
  getArtifactResultSchema,
  listArtifactsRequestSchema,
  listArtifactsResultSchema,
  resolveShareLinkResultSchema,
  revokeShareLinkResultSchema,
  SHARE_LINK_STATUSES,
  shareLinkSchema,
  uploadAuthorizationSchema,
} from "./artifacts.ts";
export type {
  ArtifactDetail,
  ArtifactIdempotencyConflictResult,
  ArtifactMutationReplayMetadata,
  ArtifactSummary,
  ArtifactUploadResource,
  ArtifactUploadStatus,
  ArtifactVerificationStatus,
  ArtifactVersionResource,
  ArtifactVersionSource,
  CompleteArtifactUploadResult,
  CreateArtifactDownloadRequest,
  CreateArtifactDownloadResult,
  CreateArtifactUploadRequest,
  CreateArtifactUploadResult,
  CreateShareLinkRequest,
  CreateShareLinkResult,
  DownloadAuthorizationResource,
  GetArtifactResult,
  ListArtifactsRequest,
  ListArtifactsResult,
  ResolveShareLinkResult,
  RevokeShareLinkResult,
  ShareLinkResource,
  ShareLinkStatus,
  UploadAuthorizationResource,
  UploadTarget,
} from "./artifacts.ts";

export {
  getUsageSummaryResultSchema,
  USAGE_PERIODS,
  usageSummaryItemSchema,
  usageSummaryRequestSchema,
  usageSummarySchema,
} from "./usage.ts";
export type {
  GetUsageSummaryResult,
  UsagePeriod,
  UsageSummary,
  UsageSummaryItem,
  UsageSummaryRequest,
} from "./usage.ts";

export {
  listWorkspaceEventsRequestSchema,
  listWorkspaceEventsResultSchema,
  WORKSPACE_EVENT_TYPES,
  workspaceEventEnvelopeSchema,
} from "./events.ts";
export type {
  ListWorkspaceEventsRequest,
  ListWorkspaceEventsResult,
  WorkspaceEventData,
  WorkspaceEventEnvelope,
  WorkspaceEventType,
} from "./events.ts";

export { RELAY_MCP_RESOURCE_SCOPES } from "./mcp.ts";
export type { RelayMcpResourceScope } from "./mcp.ts";

export interface BuildInfo {
  readonly version: string;
  readonly revision: string;
}

export interface ServiceHealth {
  readonly service: string;
  readonly status: "ok" | "degraded";
  readonly build: BuildInfo;
}

export interface ReadinessCheck {
  readonly name: string;
  readonly status: "ok" | "error";
  /** Sanitized detail only -- never a connection string, credential, or raw driver error. */
  readonly message?: string;
}
