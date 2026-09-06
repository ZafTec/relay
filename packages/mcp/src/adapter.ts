import {
  type CallToolResult,
  fromJsonSchema,
  type JsonSchemaType,
  McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import {
  validateIdempotencyKey,
  validateWorkspaceActorContext,
  type WorkspaceActorContext,
} from "@relay/application/context";
import type { ApplicationServices } from "@relay/application/services";
import {
  cancelRunResultSchema,
  completeArtifactUploadResultSchema,
  type ContractSchema,
  ContractValidationError,
  createArtifactUploadRequestSchema,
  createArtifactUploadResultSchema,
  createRunRequestSchema,
  createRunResultSchema,
  createShareLinkRequestSchema,
  createShareLinkResultSchema,
  type ErrorCode,
  errorEnvelopeSchema,
  getArtifactResultSchema,
  getRunResultSchema,
  getToolResultSchema,
  listArtifactsRequestSchema,
  listArtifactsResultSchema,
  listRunsRequestSchema,
  listRunsResultSchema,
  listToolsRequestSchema,
  listToolsResultSchema,
  type PublicErrorDetails,
  RELAY_MCP_RESOURCE_SCOPES,
  type RelayMcpResourceScope,
  revokeShareLinkResultSchema,
  type ToolDetail,
} from "@relay/contracts";
import {
  cancelRunInputSchema,
  completeArtifactUploadInputSchema,
  createArtifactUploadInputSchema,
  createShareLinkInputSchema,
  executableToolResultSchema,
  getArtifactInputSchema,
  getRunInputSchema,
  getToolInputSchema,
  listArtifactsInputSchema,
  listRunsInputSchema,
  listToolsInputSchema,
  revokeShareLinkInputSchema,
} from "./schemas.ts";

export const RELAY_MCP_TOOL_NAMES: Readonly<{
  listTools: "relay.tools.list";
  getTool: "relay.tools.get";
  getRun: "relay.runs.get";
  listRuns: "relay.runs.list";
  cancelRun: "relay.runs.cancel";
  getArtifact: "relay.artifacts.get";
  listArtifacts: "relay.artifacts.list";
  createArtifactUpload: "relay.artifacts.create_upload";
  completeArtifactUpload: "relay.artifacts.complete_upload";
  createShareLink: "relay.artifacts.create_share_link";
  revokeShareLink: "relay.artifacts.revoke_share_link";
}> = Object.freeze({
  listTools: "relay.tools.list",
  getTool: "relay.tools.get",
  getRun: "relay.runs.get",
  listRuns: "relay.runs.list",
  cancelRun: "relay.runs.cancel",
  getArtifact: "relay.artifacts.get",
  listArtifacts: "relay.artifacts.list",
  createArtifactUpload: "relay.artifacts.create_upload",
  completeArtifactUpload: "relay.artifacts.complete_upload",
  createShareLink: "relay.artifacts.create_share_link",
  revokeShareLink: "relay.artifacts.revoke_share_link",
});

export type RelayMcpManagementToolName =
  (typeof RELAY_MCP_TOOL_NAMES)[keyof typeof RELAY_MCP_TOOL_NAMES];

export const RELAY_MCP_SCOPES: typeof RELAY_MCP_RESOURCE_SCOPES =
  RELAY_MCP_RESOURCE_SCOPES;
export type RelayMcpScope = RelayMcpResourceScope;

export const RELAY_MCP_MANAGEMENT_TOOL_SCOPES: Readonly<
  Record<RelayMcpManagementToolName, readonly RelayMcpScope[]>
> = Object.freeze({
  [RELAY_MCP_TOOL_NAMES.listTools]: ["tools:read"],
  [RELAY_MCP_TOOL_NAMES.getTool]: ["tools:read"],
  [RELAY_MCP_TOOL_NAMES.getRun]: ["runs:read"],
  [RELAY_MCP_TOOL_NAMES.listRuns]: ["runs:read"],
  [RELAY_MCP_TOOL_NAMES.cancelRun]: ["runs:cancel"],
  [RELAY_MCP_TOOL_NAMES.getArtifact]: ["artifacts:read"],
  [RELAY_MCP_TOOL_NAMES.listArtifacts]: ["artifacts:read"],
  [RELAY_MCP_TOOL_NAMES.createArtifactUpload]: ["artifacts:write"],
  [RELAY_MCP_TOOL_NAMES.completeArtifactUpload]: ["artifacts:write"],
  [RELAY_MCP_TOOL_NAMES.createShareLink]: ["artifacts:share"],
  [RELAY_MCP_TOOL_NAMES.revokeShareLink]: ["artifacts:share"],
});

export const RELAY_MCP_PROTOCOL_VERSION = "2026-07-28" as const;
export const RELAY_MCP_IDEMPOTENCY_META_KEY =
  "io.relay/idempotency-key" as const;

const MANAGEMENT_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  Object.values(RELAY_MCP_TOOL_NAMES),
);
const MAX_CATALOG_PAGES = 100;
const CATALOG_PAGE_SIZE = 100;

export interface RelayMcpPrincipal {
  readonly identity: WorkspaceActorContext;
  readonly scopes: readonly string[];
  readonly clientId?: string;
}

export interface McpIdempotencyContext {
  readonly toolKey: string;
  readonly workspaceId: string;
  readonly actorUserId: string;
  readonly clientId?: string;
  readonly requestId: string | number;
  readonly suppliedKey?: string;
}

export type McpIdempotencyKeyFactory = (
  context: McpIdempotencyContext,
) => string | Promise<string>;

export interface CreateRelayMcpServerOptions {
  readonly services: ApplicationServices;
  readonly principal: RelayMcpPrincipal;
  readonly serverInfo?: {
    readonly name: string;
    readonly version: string;
  };
  readonly createIdempotencyKey?: McpIdempotencyKeyFactory;
}

type ToolOutcome =
  | {
    readonly success: true;
    readonly text: string;
  }
  | {
    readonly success: false;
    readonly text: string;
    readonly code: ErrorCode;
    readonly retryable?: boolean;
    readonly details?: PublicErrorDetails;
  };

function requiredScopeMetadata(scopes: readonly RelayMcpScope[]) {
  return { "io.relay/required-scopes": [...scopes] };
}

function toolErrorResult(
  code: ErrorCode,
  text: string,
  options: {
    readonly retryable?: boolean;
    readonly details?: PublicErrorDetails;
  } = {},
): CallToolResult {
  const structuredContent = errorEnvelopeSchema.parse({
    error: {
      code,
      message: text,
      retryable: options.retryable ?? false,
      requestId: `req_${crypto.randomUUID()}`,
      details: options.details ?? {},
    },
  });
  return {
    content: [{ type: "text", text }],
    structuredContent,
    isError: true,
  };
}

function structuredResult(
  value: Readonly<Record<string, unknown>>,
  text: string,
): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: value,
  };
}

function missingScopeResult(scopes: readonly RelayMcpScope[]): CallToolResult {
  return toolErrorResult(
    "authentication_required",
    `Missing required OAuth scope${scopes.length === 1 ? "" : "s"}: ${
      scopes.join(" ")
    }.`,
  );
}

function hasScopes(
  grantedScopes: ReadonlySet<string>,
  requiredScopes: readonly RelayMcpScope[],
): boolean {
  return requiredScopes.every((scope) => grantedScopes.has(scope));
}

function resultOutcome(
  toolName: RelayMcpManagementToolName,
  result: Readonly<Record<string, unknown>>,
): ToolOutcome {
  const kind = result.kind;
  if (kind === "idempotency_conflict") {
    return {
      success: false,
      text: "The idempotency key was already used for a different request.",
      code: "idempotency_conflict",
    };
  }
  switch (toolName) {
    case RELAY_MCP_TOOL_NAMES.listTools:
      return kind === "ok"
        ? {
          success: true,
          text: `Returned ${
            (result.items as readonly unknown[]).length
          } tools.`,
        }
        : {
          success: false,
          text: "The workspace was not found.",
          code: "not_found",
          details: { resource: "workspace" },
        };
    case RELAY_MCP_TOOL_NAMES.getTool:
      return kind === "found"
        ? { success: true, text: "Tool details returned." }
        : {
          success: false,
          text: "The tool was not found.",
          code: "not_found",
          details: { resource: "tool" },
        };
    case RELAY_MCP_TOOL_NAMES.listRuns:
      return kind === "ok"
        ? {
          success: true,
          text: `Returned ${(result.items as readonly unknown[]).length} runs.`,
        }
        : {
          success: false,
          text: "The workspace was not found.",
          code: "not_found",
          details: { resource: "workspace" },
        };
    case RELAY_MCP_TOOL_NAMES.getRun:
      return kind === "found"
        ? {
          success: true,
          text: `Run ${(result.run as { id: string }).id} is ${
            (result.run as { status: string }).status
          }.`,
        }
        : {
          success: false,
          text: "The run was not found.",
          code: "not_found",
          details: { resource: "run" },
        };
    case RELAY_MCP_TOOL_NAMES.cancelRun:
      return kind === "not_found"
        ? {
          success: false,
          text: "The run was not found.",
          code: "not_found",
          details: { resource: "run" },
        }
        : {
          success: true,
          text: kind === "cancel_requested"
            ? "Run cancellation was requested."
            : kind === "already_terminal"
            ? "The run was already terminal."
            : "The run was cancelled.",
        };
    case RELAY_MCP_TOOL_NAMES.listArtifacts:
      return kind === "ok"
        ? {
          success: true,
          text: `Returned ${
            (result.items as readonly unknown[]).length
          } artifacts.`,
        }
        : {
          success: false,
          text: "The workspace was not found.",
          code: "not_found",
          details: { resource: "workspace" },
        };
    case RELAY_MCP_TOOL_NAMES.getArtifact:
      return kind === "found"
        ? { success: true, text: "Artifact details returned." }
        : {
          success: false,
          text: "The artifact was not found.",
          code: "not_found",
          details: { resource: "artifact" },
        };
    case RELAY_MCP_TOOL_NAMES.createArtifactUpload:
      return kind === "created"
        ? { success: true, text: "Upload authorization created." }
        : kind === "quota_exceeded"
        ? {
          success: false,
          text: "The workspace upload quota was exceeded.",
          code: "upload_quota_exceeded",
        }
        : {
          success: false,
          text: "The upload target was not found.",
          code: "not_found",
          details: { resource: "artifact" },
        };
    case RELAY_MCP_TOOL_NAMES.completeArtifactUpload:
      return kind === "completed"
        ? { success: true, text: "Upload completion was recorded." }
        : kind === "pending"
        ? { success: true, text: "The upload is still pending." }
        : kind === "verification_failed"
        ? {
          success: false,
          text: "The uploaded object failed verification.",
          code: "upload_verification_failed",
          details: { reason: result.reason as string },
        }
        : {
          success: false,
          text: "The upload was not found.",
          code: "not_found",
          details: { resource: "upload" },
        };
    case RELAY_MCP_TOOL_NAMES.createShareLink:
      return kind === "created"
        ? { success: true, text: "Share link created." }
        : kind === "conflict"
        ? {
          success: false,
          text: "The share policy conflicts with the current artifact state.",
          code: "invalid_request",
          details: { reason: "share_policy_conflict" },
        }
        : {
          success: false,
          text: "The artifact was not found.",
          code: "not_found",
          details: { resource: "artifact" },
        };
    case RELAY_MCP_TOOL_NAMES.revokeShareLink:
      return kind === "not_found"
        ? {
          success: false,
          text: "The share link was not found.",
          code: "not_found",
          details: { resource: "share_link" },
        }
        : {
          success: true,
          text: kind === "already_revoked"
            ? "The share link was already revoked."
            : "Share link revoked.",
        };
  }
}

async function callManagementTool<T>(
  grantedScopes: ReadonlySet<string>,
  requiredScopes: readonly RelayMcpScope[],
  toolName: RelayMcpManagementToolName,
  outputSchema: ContractSchema<T>,
  call: () => Promise<unknown>,
): Promise<CallToolResult> {
  if (!hasScopes(grantedScopes, requiredScopes)) {
    return missingScopeResult(requiredScopes);
  }
  try {
    const result = outputSchema.parse(await call());
    const structured = result as Readonly<Record<string, unknown>>;
    const outcome = resultOutcome(toolName, structured);
    return outcome.success
      ? structuredResult(structured, outcome.text)
      : toolErrorResult(outcome.code, outcome.text, {
        retryable: outcome.retryable,
        details: outcome.details,
      });
  } catch (error) {
    if (error instanceof McpInputError) {
      return toolErrorResult(
        "invalid_request",
        "The required idempotency metadata is missing or invalid.",
      );
    }
    if (error instanceof ContractValidationError) {
      return toolErrorResult(
        "invalid_request",
        "The tool arguments or service response were invalid.",
      );
    }
    return toolErrorResult("internal_error", "The tool call failed.");
  }
}

async function collectExecutableTools(
  services: ApplicationServices,
  identity: WorkspaceActorContext,
): Promise<readonly ToolDetail[]> {
  const details: ToolDetail[] = [];
  const seenKeys = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
    const request = listToolsRequestSchema.parse({
      cursor,
      limit: CATALOG_PAGE_SIZE,
    });
    const result = listToolsResultSchema.parse(
      await services.tools.list(identity, request),
    );
    if (result.kind === "not_found") return [];

    for (const summary of result.items) {
      if (MANAGEMENT_TOOL_NAME_SET.has(summary.key)) {
        throw new TypeError(
          `catalog tool uses reserved MCP name: ${summary.key}`,
        );
      }
      if (seenKeys.has(summary.key)) {
        throw new TypeError(
          `catalog returned duplicate tool key: ${summary.key}`,
        );
      }
      seenKeys.add(summary.key);
      const detailResult = getToolResultSchema.parse(
        await services.tools.get(identity, summary.key),
      );
      if (detailResult.kind === "found") details.push(detailResult.tool);
    }

    if (result.nextCursor === null) {
      return details.sort((left, right) => left.key.localeCompare(right.key));
    }
    if (seenCursors.has(result.nextCursor)) {
      throw new TypeError("catalog pagination repeated a cursor");
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }

  throw new TypeError("catalog pagination exceeded the MCP registration limit");
}

class McpInputError extends TypeError {}

function checkedIdempotencyKey(value: string): string {
  try {
    return validateIdempotencyKey(value);
  } catch {
    throw new McpInputError("MCP idempotency key has an invalid format");
  }
}

function defaultIdempotencyKey(context: McpIdempotencyContext): string {
  if (context.suppliedKey === undefined) {
    throw new McpInputError("MCP idempotency key is required");
  }
  return checkedIdempotencyKey(context.suppliedKey);
}

function suppliedIdempotencyKey(context: ServerContext): string | undefined {
  const metadata = context.mcpReq._meta;
  if (
    metadata === undefined ||
    !Object.hasOwn(metadata, RELAY_MCP_IDEMPOTENCY_META_KEY)
  ) {
    return undefined;
  }
  const value = metadata[RELAY_MCP_IDEMPOTENCY_META_KEY];
  if (typeof value !== "string") {
    throw new McpInputError("MCP idempotency key must be a string");
  }
  return value;
}

function requireMcpIdempotencyKey(context: ServerContext): string {
  const value = suppliedIdempotencyKey(context);
  if (value === undefined) {
    throw new McpInputError("MCP idempotency key is required");
  }
  return checkedIdempotencyKey(value);
}

function executableError(
  result: Readonly<Record<string, unknown>>,
): CallToolResult {
  switch (result.kind) {
    case "not_found":
      return toolErrorResult("not_found", "The tool was not found.", {
        details: { resource: "tool" },
      });
    case "tool_unavailable":
      return toolErrorResult(
        "tool_unavailable",
        "The tool is not currently available.",
      );
    case "idempotency_conflict":
      return toolErrorResult(
        "idempotency_conflict",
        "The idempotency key was already used for different input.",
      );
    case "queue_full":
      return toolErrorResult(
        "tool_queue_full",
        "The tool queue is temporarily at capacity.",
        {
          retryable: true,
          details: {
            scope: result.scope as
              | "global_tool"
              | "workspace_total"
              | "workspace_tool",
          },
        },
      );
    default:
      return toolErrorResult("internal_error", "The tool call failed.");
  }
}

function executableSuccess(
  result: ReturnType<typeof createRunResultSchema.parse> & {
    readonly kind: "accepted";
  },
): Readonly<Record<string, unknown>> {
  return executableToolResultSchema.parse({
    runId: result.run.id,
    status: result.run.status,
    replayed: result.replayed,
    queueReason: result.queueReason,
    reservation: result.run.reservation === null ? null : {
      metric: result.run.reservation.metric,
      unit: result.run.reservation.unit,
      amount: result.run.reservation.amount,
      status: result.run.reservation.status,
      expiresAt: result.run.reservation.expiresAt,
    },
    statusTool: RELAY_MCP_TOOL_NAMES.getRun,
  });
}

export async function createRelayMcpServer(
  options: CreateRelayMcpServerOptions,
): Promise<McpServer> {
  if (options?.services === undefined) {
    throw new TypeError("services are required");
  }
  if (options.principal === undefined) {
    throw new TypeError("principal is required");
  }
  const services = options.services;
  const identity = validateWorkspaceActorContext(options.principal.identity);
  const grantedScopes = new Set(options.principal.scopes);
  const server = new McpServer(
    options.serverInfo ?? { name: "relay", version: "0.0.0" },
    { supportedProtocolVersions: [RELAY_MCP_PROTOCOL_VERSION] },
  );

  server.registerTool(
    RELAY_MCP_TOOL_NAMES.listTools,
    {
      title: "List Relay tools",
      description: "List tools available to the current workspace.",
      inputSchema: listToolsInputSchema,
      outputSchema: fromJsonSchema(listToolsResultSchema.jsonSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: requiredScopeMetadata(
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[RELAY_MCP_TOOL_NAMES.listTools],
      ),
    },
    (args) =>
      callManagementTool(
        grantedScopes,
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[RELAY_MCP_TOOL_NAMES.listTools],
        RELAY_MCP_TOOL_NAMES.listTools,
        listToolsResultSchema,
        () => services.tools.list(identity, listToolsRequestSchema.parse(args)),
      ),
  );

  server.registerTool(
    RELAY_MCP_TOOL_NAMES.getTool,
    {
      title: "Get a Relay tool",
      description: "Get the active contract for an available tool.",
      inputSchema: getToolInputSchema,
      outputSchema: fromJsonSchema(getToolResultSchema.jsonSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: requiredScopeMetadata(
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[RELAY_MCP_TOOL_NAMES.getTool],
      ),
    },
    (args) =>
      callManagementTool(
        grantedScopes,
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[RELAY_MCP_TOOL_NAMES.getTool],
        RELAY_MCP_TOOL_NAMES.getTool,
        getToolResultSchema,
        () => services.tools.get(identity, args.toolKey),
      ),
  );

  server.registerTool(
    RELAY_MCP_TOOL_NAMES.listRuns,
    {
      title: "List Relay runs",
      description: "List runs owned by the current workspace.",
      inputSchema: listRunsInputSchema,
      outputSchema: fromJsonSchema(listRunsResultSchema.jsonSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: requiredScopeMetadata(
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[RELAY_MCP_TOOL_NAMES.listRuns],
      ),
    },
    (args) =>
      callManagementTool(
        grantedScopes,
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[RELAY_MCP_TOOL_NAMES.listRuns],
        RELAY_MCP_TOOL_NAMES.listRuns,
        listRunsResultSchema,
        () => services.runs.list(identity, listRunsRequestSchema.parse(args)),
      ),
  );

  server.registerTool(
    RELAY_MCP_TOOL_NAMES.getRun,
    {
      title: "Get a Relay run",
      description: "Get the current status and outputs of a workspace run.",
      inputSchema: getRunInputSchema,
      outputSchema: fromJsonSchema(getRunResultSchema.jsonSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: requiredScopeMetadata(
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[RELAY_MCP_TOOL_NAMES.getRun],
      ),
    },
    (args) =>
      callManagementTool(
        grantedScopes,
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[RELAY_MCP_TOOL_NAMES.getRun],
        RELAY_MCP_TOOL_NAMES.getRun,
        getRunResultSchema,
        () => services.runs.get(identity, args.runId),
      ),
  );

  server.registerTool(
    RELAY_MCP_TOOL_NAMES.cancelRun,
    {
      title: "Cancel a Relay run",
      description: "Request cancellation of a non-terminal workspace run.",
      inputSchema: cancelRunInputSchema,
      outputSchema: fromJsonSchema(cancelRunResultSchema.jsonSchema),
      annotations: { destructiveHint: true, idempotentHint: true },
      _meta: requiredScopeMetadata(
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[RELAY_MCP_TOOL_NAMES.cancelRun],
      ),
    },
    (args) =>
      callManagementTool(
        grantedScopes,
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[RELAY_MCP_TOOL_NAMES.cancelRun],
        RELAY_MCP_TOOL_NAMES.cancelRun,
        cancelRunResultSchema,
        () => services.runs.cancel(identity, args.runId),
      ),
  );

  server.registerTool(
    RELAY_MCP_TOOL_NAMES.listArtifacts,
    {
      title: "List Relay artifacts",
      description: "List artifacts owned by the current workspace.",
      inputSchema: listArtifactsInputSchema,
      outputSchema: fromJsonSchema(listArtifactsResultSchema.jsonSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: requiredScopeMetadata(
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[RELAY_MCP_TOOL_NAMES.listArtifacts],
      ),
    },
    (args) =>
      callManagementTool(
        grantedScopes,
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[RELAY_MCP_TOOL_NAMES.listArtifacts],
        RELAY_MCP_TOOL_NAMES.listArtifacts,
        listArtifactsResultSchema,
        () =>
          services.artifacts.list(
            identity,
            listArtifactsRequestSchema.parse(args),
          ),
      ),
  );

  server.registerTool(
    RELAY_MCP_TOOL_NAMES.getArtifact,
    {
      title: "Get a Relay artifact",
      description: "Get artifact metadata and immutable version identifiers.",
      inputSchema: getArtifactInputSchema,
      outputSchema: fromJsonSchema(getArtifactResultSchema.jsonSchema),
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: requiredScopeMetadata(
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[RELAY_MCP_TOOL_NAMES.getArtifact],
      ),
    },
    (args) =>
      callManagementTool(
        grantedScopes,
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[RELAY_MCP_TOOL_NAMES.getArtifact],
        RELAY_MCP_TOOL_NAMES.getArtifact,
        getArtifactResultSchema,
        () => services.artifacts.get(identity, args.artifactId),
      ),
  );

  server.registerTool(
    RELAY_MCP_TOOL_NAMES.createArtifactUpload,
    {
      title: "Create a Relay artifact upload",
      description:
        "Create metadata and a short-lived direct object-storage upload authorization. File bytes are not accepted.",
      inputSchema: createArtifactUploadInputSchema,
      outputSchema: fromJsonSchema(createArtifactUploadResultSchema.jsonSchema),
      annotations: { readOnlyHint: false, idempotentHint: true },
      _meta: requiredScopeMetadata(
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[
          RELAY_MCP_TOOL_NAMES.createArtifactUpload
        ],
      ),
    },
    (args, context) =>
      callManagementTool(
        grantedScopes,
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[
          RELAY_MCP_TOOL_NAMES.createArtifactUpload
        ],
        RELAY_MCP_TOOL_NAMES.createArtifactUpload,
        createArtifactUploadResultSchema,
        () =>
          services.artifacts.createUpload(
            identity,
            createArtifactUploadRequestSchema.parse(args),
            requireMcpIdempotencyKey(context),
          ),
      ),
  );

  server.registerTool(
    RELAY_MCP_TOOL_NAMES.completeArtifactUpload,
    {
      title: "Complete a Relay artifact upload",
      description:
        "Verify a direct upload and make the uploaded artifact version available.",
      inputSchema: completeArtifactUploadInputSchema,
      outputSchema: fromJsonSchema(
        completeArtifactUploadResultSchema.jsonSchema,
      ),
      annotations: { readOnlyHint: false, idempotentHint: true },
      _meta: requiredScopeMetadata(
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[
          RELAY_MCP_TOOL_NAMES.completeArtifactUpload
        ],
      ),
    },
    (args, context) =>
      callManagementTool(
        grantedScopes,
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[
          RELAY_MCP_TOOL_NAMES.completeArtifactUpload
        ],
        RELAY_MCP_TOOL_NAMES.completeArtifactUpload,
        completeArtifactUploadResultSchema,
        () =>
          services.artifacts.completeUpload(
            identity,
            args.uploadId,
            requireMcpIdempotencyKey(context),
          ),
      ),
  );

  server.registerTool(
    RELAY_MCP_TOOL_NAMES.createShareLink,
    {
      title: "Create a Relay artifact share link",
      description: "Create a revocable share link for a workspace artifact.",
      inputSchema: createShareLinkInputSchema,
      outputSchema: fromJsonSchema(createShareLinkResultSchema.jsonSchema),
      annotations: { readOnlyHint: false, idempotentHint: true },
      _meta: requiredScopeMetadata(
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[
          RELAY_MCP_TOOL_NAMES.createShareLink
        ],
      ),
    },
    (args, context) =>
      callManagementTool(
        grantedScopes,
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[
          RELAY_MCP_TOOL_NAMES.createShareLink
        ],
        RELAY_MCP_TOOL_NAMES.createShareLink,
        createShareLinkResultSchema,
        () =>
          services.artifacts.createShareLink(
            identity,
            createShareLinkRequestSchema.parse(args),
            requireMcpIdempotencyKey(context),
          ),
      ),
  );

  server.registerTool(
    RELAY_MCP_TOOL_NAMES.revokeShareLink,
    {
      title: "Revoke a Relay artifact share link",
      description: "Revoke an existing workspace artifact share link.",
      inputSchema: revokeShareLinkInputSchema,
      outputSchema: fromJsonSchema(revokeShareLinkResultSchema.jsonSchema),
      annotations: { destructiveHint: true, idempotentHint: true },
      _meta: requiredScopeMetadata(
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[
          RELAY_MCP_TOOL_NAMES.revokeShareLink
        ],
      ),
    },
    (args, context) =>
      callManagementTool(
        grantedScopes,
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[
          RELAY_MCP_TOOL_NAMES.revokeShareLink
        ],
        RELAY_MCP_TOOL_NAMES.revokeShareLink,
        revokeShareLinkResultSchema,
        () =>
          services.artifacts.revokeShareLink(
            identity,
            args.artifactId,
            args.shareLinkId,
            requireMcpIdempotencyKey(context),
          ),
      ),
  );

  if (grantedScopes.has("tools:execute")) {
    const executableTools = await collectExecutableTools(
      services,
      identity,
    );
    for (const tool of executableTools) {
      if (
        tool.inputSchema === null || typeof tool.inputSchema !== "object" ||
        Array.isArray(tool.inputSchema) ||
        (tool.inputSchema as Record<string, unknown>).type !== "object"
      ) {
        throw new TypeError(
          `catalog tool input schema must describe an object: ${tool.key}`,
        );
      }
      const inputSchema = fromJsonSchema(
        tool.inputSchema as JsonSchemaType,
      );
      server.registerTool(
        tool.key,
        {
          title: tool.name,
          description: tool.summary ?? `Execute ${tool.name}.`,
          inputSchema,
          outputSchema: executableToolResultSchema,
          annotations: { readOnlyHint: false, idempotentHint: true },
          _meta: {
            ...requiredScopeMetadata(["tools:execute"]),
            "io.relay/tool-version-id": tool.activeVersionId,
            "io.relay/tool-version": tool.version,
            "io.relay/catalog-output-schema": tool.outputSchema,
          },
        },
        async (args, context) => {
          if (!grantedScopes.has("tools:execute")) {
            return missingScopeResult(["tools:execute"]);
          }
          try {
            const keyFactory = options.createIdempotencyKey ??
              defaultIdempotencyKey;
            const idempotencyKey = checkedIdempotencyKey(
              await keyFactory({
                toolKey: tool.key,
                workspaceId: identity.workspaceId,
                actorUserId: identity.actorUserId,
                clientId: options.principal.clientId ??
                  context.http?.authInfo?.clientId,
                requestId: context.mcpReq.id,
                suppliedKey: suppliedIdempotencyKey(context),
              }),
            );
            const request = createRunRequestSchema.parse({
              toolKey: tool.key,
              input: args,
            });
            const result = createRunResultSchema.parse(
              await services.runs.create(
                identity,
                request,
                idempotencyKey,
                tool.activeVersionId,
              ),
            );
            if (result.kind !== "accepted") {
              return executableError(result);
            }
            const output = executableSuccess(result);
            return structuredResult(
              output,
              `Run ${result.run.id} was accepted with status ${result.run.status}.`,
            );
          } catch (error) {
            if (
              error instanceof ContractValidationError ||
              error instanceof McpInputError
            ) {
              return toolErrorResult(
                "invalid_request",
                "The tool arguments or service response were invalid.",
              );
            }
            return toolErrorResult("internal_error", "The tool call failed.");
          }
        },
      );
    }
  }

  return server;
}
