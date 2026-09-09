import type { HandlerRegistry } from "@relay/catalog";
import { createOverviewService } from "./overview.ts";
import type {
  CancelRunResult,
  CreateRunRequest,
  CreateRunResult,
  GetRunResult,
  ListRunsRequest,
  ListRunsResult,
} from "@relay/contracts";
import type { DatabasePool } from "@relay/database";
import type { AdmissionUsagePort } from "@relay/queue";
import {
  ArtifactCommandAdapter,
  type ArtifactCommandPort,
} from "./artifact-commands.ts";
import { RunAdmissionAdapter, type RunAdmissionPolicy } from "./admission.ts";
import type { WorkspaceActorContext } from "./context.ts";
import { PostgresArtifactReadService } from "./postgres/artifacts.ts";
import { PostgresWorkspaceEventService } from "./postgres/events.ts";
import {
  PostgresRunCancellationService,
  PostgresRunReadService,
} from "./postgres/runs.ts";
import { PostgresToolService } from "./postgres/tools.ts";
import {
  PostgresUsageService,
  type StorageUsageLimitResolver,
} from "./postgres/usage.ts";
import type { ApplicationServices, RunApplicationService } from "./services.ts";

export interface PostgresReadServices {
  readonly tools: PostgresToolService;
  readonly runs: PostgresRunReadService;
  readonly artifacts: PostgresArtifactReadService;
  readonly usage: PostgresUsageService;
  readonly events: PostgresWorkspaceEventService;
}

export interface CreateApplicationServicesOptions extends RunAdmissionPolicy {
  readonly pool: DatabasePool;
  readonly handlers: HandlerRegistry;
  readonly admissionUsage: AdmissionUsagePort;
  /** Existing domain service; this factory never creates object storage. */
  readonly artifactCommands: ArtifactCommandPort;
  /** Resolve through the same provider that admits artifact storage. */
  readonly storageLimit?: StorageUsageLimitResolver;
}

export function createPostgresReadServices(
  pool: DatabasePool,
  handlers: HandlerRegistry,
  storageLimit?: StorageUsageLimitResolver,
): PostgresReadServices {
  return {
    tools: new PostgresToolService(pool, handlers),
    runs: new PostgresRunReadService(pool),
    artifacts: new PostgresArtifactReadService(pool),
    usage: new PostgresUsageService(pool, undefined, storageLimit),
    events: new PostgresWorkspaceEventService(pool),
  };
}

export function createPostgresRunService(
  options: Omit<CreateApplicationServicesOptions, "artifactCommands">,
): RunApplicationService {
  const reads = new PostgresRunReadService(options.pool);
  const cancellations = new PostgresRunCancellationService(options.pool);
  const admission = new RunAdmissionAdapter({
    pool: options.pool,
    handlers: options.handlers,
    usage: options.admissionUsage,
    admissionDeadlineMs: options.admissionDeadlineMs,
    runDeadlineMs: options.runDeadlineMs,
  });
  return {
    create(
      context: WorkspaceActorContext,
      request: CreateRunRequest,
      idempotencyKey: string,
      expectedToolVersionId?: string,
    ): Promise<CreateRunResult> {
      return admission.create(
        context,
        request,
        idempotencyKey,
        expectedToolVersionId,
      );
    },
    list(
      context: WorkspaceActorContext,
      request: ListRunsRequest,
    ): Promise<ListRunsResult> {
      return reads.list(context, request);
    },
    get(
      context: WorkspaceActorContext,
      runId: string,
    ): Promise<GetRunResult> {
      return reads.get(context, runId);
    },
    cancel(
      context: WorkspaceActorContext,
      runId: string,
    ): Promise<CancelRunResult> {
      return cancellations.cancel(context, runId);
    },
  };
}

export function createPostgresApplicationServices(
  options: CreateApplicationServicesOptions,
): ApplicationServices {
  const reads = createPostgresReadServices(
    options.pool,
    options.handlers,
    options.storageLimit,
  );
  const commands = new ArtifactCommandAdapter(options.artifactCommands);
  return {
    overview: createOverviewService(options.pool, reads.runs, reads.artifacts),
    tools: reads.tools,
    runs: createPostgresRunService(options),
    artifacts: {
      list: (context, request) => reads.artifacts.list(context, request),
      createDownload: (context, request) =>
        commands.createDownload(context, request),
      get: (context, artifactId) => reads.artifacts.get(context, artifactId),
      createUpload: (context, request, idempotencyKey) =>
        commands.createUpload(context, request, idempotencyKey),
      completeUpload: (context, uploadId, idempotencyKey) =>
        commands.completeUpload(context, uploadId, idempotencyKey),
      createShareLink: (context, request, idempotencyKey) =>
        commands.createShareLink(context, request, idempotencyKey),
      revokeShareLink: (
        context,
        artifactId,
        shareLinkId,
        idempotencyKey,
      ) =>
        commands.revokeShareLink(
          context,
          artifactId,
          shareLinkId,
          idempotencyKey,
        ),
      resolveShareLink: (token, actorUserId) =>
        commands.resolveShareLink(token, actorUserId),
    },
    usage: reads.usage,
    events: reads.events,
  };
}
