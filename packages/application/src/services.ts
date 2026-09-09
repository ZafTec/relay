import type {
  CancelRunResult,
  CompleteArtifactUploadResult,
  CreateArtifactDownloadRequest,
  CreateArtifactDownloadResult,
  CreateArtifactUploadRequest,
  CreateArtifactUploadResult,
  CreateRunRequest,
  CreateRunResult,
  CreateShareLinkRequest,
  CreateShareLinkResult,
  GetArtifactResult,
  GetRunResult,
  GetStorageUsageResult,
  GetToolResult,
  GetUsageSummaryResult,
  ListArtifactsRequest,
  ListArtifactsResult,
  ListRunsRequest,
  ListRunsResult,
  ListToolsRequest,
  ListToolsResult,
  ListWorkspaceEventsRequest,
  ListWorkspaceEventsResult,
  ResolveShareLinkResult,
  RevokeShareLinkResult,
  UsageSummaryRequest,
} from "@relay/contracts";
import type { WorkspaceActorContext } from "./context.ts";
import type { NotificationService } from "@relay/notifications";
import type { ContentApplicationService } from "./content.ts";

export interface ToolApplicationService {
  list(
    context: WorkspaceActorContext,
    request: ListToolsRequest,
  ): Promise<ListToolsResult>;
  get(
    context: WorkspaceActorContext,
    toolKey: string,
  ): Promise<GetToolResult>;
}

export interface RunReadApplicationService {
  list(
    context: WorkspaceActorContext,
    request: ListRunsRequest,
  ): Promise<ListRunsResult>;
  get(
    context: WorkspaceActorContext,
    runId: string,
  ): Promise<GetRunResult>;
}

export interface RunAdmissionApplicationService {
  create(
    context: WorkspaceActorContext,
    request: CreateRunRequest,
    idempotencyKey: string,
    expectedToolVersionId?: string,
  ): Promise<CreateRunResult>;
}

export interface RunCancellationApplicationService {
  cancel(
    context: WorkspaceActorContext,
    runId: string,
  ): Promise<CancelRunResult>;
}

export interface RunApplicationService
  extends
    RunReadApplicationService,
    RunAdmissionApplicationService,
    RunCancellationApplicationService {}

export interface ArtifactReadApplicationService {
  list(
    context: WorkspaceActorContext,
    request: ListArtifactsRequest,
  ): Promise<ListArtifactsResult>;
  get(
    context: WorkspaceActorContext,
    artifactId: string,
  ): Promise<GetArtifactResult>;
}

export interface ArtifactCommandApplicationService {
  createDownload(
    context: WorkspaceActorContext,
    request: CreateArtifactDownloadRequest,
  ): Promise<CreateArtifactDownloadResult>;
  createUpload(
    context: WorkspaceActorContext,
    request: CreateArtifactUploadRequest,
    idempotencyKey: string,
  ): Promise<CreateArtifactUploadResult>;
  completeUpload(
    context: WorkspaceActorContext,
    uploadId: string,
    idempotencyKey: string,
  ): Promise<CompleteArtifactUploadResult>;
  createShareLink(
    context: WorkspaceActorContext,
    request: CreateShareLinkRequest,
    idempotencyKey: string,
  ): Promise<CreateShareLinkResult>;
  revokeShareLink(
    context: WorkspaceActorContext,
    artifactId: string,
    shareLinkId: string,
    idempotencyKey: string,
  ): Promise<RevokeShareLinkResult>;
  resolveShareLink(
    token: string,
    actorUserId?: string,
  ): Promise<ResolveShareLinkResult>;
}

export interface UsageApplicationService {
  getStorageSummary(
    context: WorkspaceActorContext,
  ): Promise<GetStorageUsageResult>;
  getSummary(
    context: WorkspaceActorContext,
    request: UsageSummaryRequest,
  ): Promise<GetUsageSummaryResult>;
}

export interface WorkspaceEventApplicationService {
  list(
    context: WorkspaceActorContext,
    request: ListWorkspaceEventsRequest,
  ): Promise<ListWorkspaceEventsResult>;
}

export interface ApplicationServices {
  readonly overview?: import("./overview.ts").OverviewApplicationService;
  readonly notifications?: NotificationService;
  readonly content?: ContentApplicationService;
  readonly tools: ToolApplicationService;
  readonly runs: RunApplicationService;
  readonly artifacts:
    & ArtifactReadApplicationService
    & ArtifactCommandApplicationService;
  readonly usage: UsageApplicationService;
  readonly events: WorkspaceEventApplicationService;
}
