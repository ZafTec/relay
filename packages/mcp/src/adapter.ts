import {
  type CallToolResult,
  fromJsonSchema,
  type JsonSchemaType,
  McpServer,
} from "@modelcontextprotocol/server";
import {
  validateWorkspaceActorContext,
  type WorkspaceActorContext,
} from "@relay/application/context";
import type { ApplicationServices } from "@relay/application/services";
import {
  contentAccessSchema,
  uploadContentSchema,
} from "@relay/application/content";
import { notificationSettingsSchema } from "@relay/notifications";
import { z } from "zod/v4";
import {
  registerRelayAdminTools,
  RELAY_MCP_ADMIN_TOOL_SCOPES,
  type RelayMcpAdminServices,
} from "./admin-tools.ts";
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
  getStorageUsageResultSchema,
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
  executeToolInputSchema,
  getArtifactInputSchema,
  getRunInputSchema,
  getToolInputSchema,
  listArtifactsInputSchema,
  listRunsInputSchema,
  listToolsInputSchema,
  revokeShareLinkInputSchema,
} from "./schemas.ts";
import {
  checkedIdempotencyKey,
  IDEMPOTENCY_INPUT_MESSAGE,
  idempotencyKeySchema,
  McpInputError,
  requireMcpIdempotencyKey,
  suppliedIdempotencyKey,
} from "./idempotency.ts";
export { RELAY_MCP_IDEMPOTENCY_META_KEY } from "./idempotency.ts";

export const RELAY_MCP_TOOL_NAMES: Readonly<{
  listTools: "relay.tools.list";
  getTool: "relay.tools.get";
  executeTool: "relay.tools.execute";
  getRun: "relay.runs.get";
  listRuns: "relay.runs.list";
  cancelRun: "relay.runs.cancel";
  getArtifact: "relay.artifacts.get";
  listArtifacts: "relay.artifacts.list";
  createArtifactUpload: "relay.artifacts.create_upload";
  completeArtifactUpload: "relay.artifacts.complete_upload";
  createShareLink: "relay.artifacts.create_share_link";
  revokeShareLink: "relay.artifacts.revoke_share_link";
  uploadContent: "relay.artifacts.upload_content";
  getAccess: "relay.artifacts.get_access";
  getNotifications: "relay.notifications.get";
  configureNotifications: "relay.notifications.configure";
  getStorageUsage: "relay.usage.storage";
}> = Object.freeze({
  listTools: "relay.tools.list",
  getTool: "relay.tools.get",
  executeTool: "relay.tools.execute",
  getRun: "relay.runs.get",
  listRuns: "relay.runs.list",
  cancelRun: "relay.runs.cancel",
  getArtifact: "relay.artifacts.get",
  listArtifacts: "relay.artifacts.list",
  createArtifactUpload: "relay.artifacts.create_upload",
  completeArtifactUpload: "relay.artifacts.complete_upload",
  createShareLink: "relay.artifacts.create_share_link",
  revokeShareLink: "relay.artifacts.revoke_share_link",
  uploadContent: "relay.artifacts.upload_content",
  getAccess: "relay.artifacts.get_access",
  getNotifications: "relay.notifications.get",
  configureNotifications: "relay.notifications.configure",
  getStorageUsage: "relay.usage.storage",
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
  [RELAY_MCP_TOOL_NAMES.executeTool]: ["tools:execute"],
  [RELAY_MCP_TOOL_NAMES.getRun]: ["runs:read"],
  [RELAY_MCP_TOOL_NAMES.listRuns]: ["runs:read"],
  [RELAY_MCP_TOOL_NAMES.cancelRun]: ["runs:cancel"],
  [RELAY_MCP_TOOL_NAMES.getArtifact]: ["artifacts:read"],
  [RELAY_MCP_TOOL_NAMES.listArtifacts]: ["artifacts:read"],
  [RELAY_MCP_TOOL_NAMES.createArtifactUpload]: ["artifacts:write"],
  [RELAY_MCP_TOOL_NAMES.completeArtifactUpload]: ["artifacts:write"],
  [RELAY_MCP_TOOL_NAMES.createShareLink]: ["artifacts:share"],
  [RELAY_MCP_TOOL_NAMES.revokeShareLink]: ["artifacts:share"],
  [RELAY_MCP_TOOL_NAMES.uploadContent]: ["artifacts:write", "artifacts:read"],
  [RELAY_MCP_TOOL_NAMES.getAccess]: ["artifacts:read"],
  [RELAY_MCP_TOOL_NAMES.getNotifications]: ["notifications:read"],
  [RELAY_MCP_TOOL_NAMES.configureNotifications]: ["notifications:write"],
  [RELAY_MCP_TOOL_NAMES.getStorageUsage]: ["usage:read"],
});

export const RELAY_MCP_PROTOCOL_VERSION = "2026-07-28" as const;
const MANAGEMENT_TOOL_NAME_SET: ReadonlySet<string> = new Set(
  [
    ...Object.values(RELAY_MCP_TOOL_NAMES),
    ...Object.keys(RELAY_MCP_ADMIN_TOOL_SCOPES),
  ],
);

export interface RelayMcpPrincipal {
  readonly identity: WorkspaceActorContext;
  readonly scopes: readonly string[];
  readonly clientId?: string;
  readonly adminSessionId?: string;
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
  readonly adminServices?: RelayMcpAdminServices;
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
    case RELAY_MCP_TOOL_NAMES.getStorageUsage:
      return kind === "ok"
        ? {
          success: true,
          text: "Current workspace storage usage and capacity.",
        }
        : kind === "not_found"
        ? {
          success: false,
          text: "The workspace was not found.",
          code: "not_found",
          details: { resource: "workspace" },
        }
        : {
          success: false,
          text: "Storage usage is temporarily unavailable.",
          code: "dependency_unavailable",
          retryable: true,
        };
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
    default:
      return {
        success: false,
        text: "The tool call failed.",
        code: "internal_error",
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
        IDEMPOTENCY_INPUT_MESSAGE,
        { details: { field: "idempotencyKey" } },
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

function defaultIdempotencyKey(context: McpIdempotencyContext): string {
  if (context.suppliedKey === undefined) {
    throw new McpInputError("MCP idempotency key is required");
  }
  return checkedIdempotencyKey(context.suppliedKey);
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
    case "not_entitled":
      return toolErrorResult(
        "not_entitled",
        "This workspace does not have permission to execute the tool. Ask an administrator for tools.execute access and the required usage allowance.",
      );
    case "allowance_exceeded":
      return toolErrorResult(
        "allowance_exceeded",
        "This run exceeds the workspace's available usage allowance. Check Usage or ask an administrator to increase the allowance.",
        {
          details: {
            metric: result.metric as string,
            unit: result.unit as string,
            limitAmount: result.limitAmount as string,
            consumedAmount: result.consumedAmount as string,
            reservedAmount: result.reservedAmount as string,
            requestedAmount: result.requestedAmount as string,
          },
        },
      );
    case "usage_unavailable":
      return toolErrorResult(
        "dependency_unavailable",
        "Relay could not verify the workspace's usage allowance. Retry with the same idempotency key after usage becomes available.",
        {
          retryable: result.reason === "unavailable",
          details: { dependency: "usage" },
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

async function validateToolInput(
  tool: ToolDetail,
  input: Record<string, unknown>,
): Promise<CallToolResult | null> {
  if (
    tool.inputSchema === null || typeof tool.inputSchema !== "object" ||
    Array.isArray(tool.inputSchema) ||
    (tool.inputSchema as Record<string, unknown>).type !== "object"
  ) throw new TypeError("Catalog input schema must describe an object");
  const validation = await fromJsonSchema(
    tool.inputSchema as JsonSchemaType,
  )["~standard"].validate(input);
  if (!validation.issues) return null;
  const path = (validation.issues[0]?.path ?? []).map((part) =>
    typeof part === "object" ? part.key : part
  ).filter((part) => /^[A-Za-z0-9_]+$/.test(String(part))).join(".");
  const field = `input${path ? `.${path}` : ""}`.slice(0, 128);
  return toolErrorResult(
    "invalid_request",
    `Invalid ${field}. Read the inputSchema from relay.tools.get and provide the required fields with their documented types and limits.`,
    { details: { field } },
  );
}

export function createRelayMcpServer(
  options: CreateRelayMcpServerOptions,
): McpServer {
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
    {
      // The stateless HTTP fallback validates every request against this list,
      // including initialized notifications and tool calls after negotiation.
      supportedProtocolVersions: [
        RELAY_MCP_PROTOCOL_VERSION,
        "2025-11-25",
        "2025-06-18",
        "2025-03-26",
      ],
    },
  );

  server.registerTool(
    RELAY_MCP_TOOL_NAMES.listTools,
    {
      title: "List Relay tools",
      description:
        "Search the workspace catalog for image generation, image editing, OCR, and other available tools. Models are catalog entries, not separate MCP tools. Inspect a selected entry with relay.tools.get before calling relay.tools.execute.",
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
      description:
        "Get a catalog tool's activeVersionId, inputSchema, outputSchema, and execution limits. Build input matching this schema, then call relay.tools.execute with its toolKey and toolVersionId.",
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
      description:
        "Get run status and stored outputs. Use relay.artifacts.get_access with an output artifact ID for a temporary download URL or a permanent revocable link.",
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
      inputSchema: createArtifactUploadInputSchema.extend({
        idempotencyKey: idempotencyKeySchema.optional(),
      }),
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
        () => {
          const { idempotencyKey, ...request } = args;
          return services.artifacts.createUpload(
            identity,
            createArtifactUploadRequestSchema.parse(request),
            requireMcpIdempotencyKey(context, idempotencyKey),
          );
        },
      ),
  );

  server.registerTool(
    RELAY_MCP_TOOL_NAMES.completeArtifactUpload,
    {
      title: "Complete a Relay artifact upload",
      description:
        "Verify a direct upload and make the uploaded artifact version available.",
      inputSchema: completeArtifactUploadInputSchema.extend({
        idempotencyKey: idempotencyKeySchema.optional(),
      }),
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
            requireMcpIdempotencyKey(context, args.idempotencyKey),
          ),
      ),
  );

  server.registerTool(
    RELAY_MCP_TOOL_NAMES.createShareLink,
    {
      title: "Create a Relay artifact share link",
      description:
        "Create a revocable share link for a workspace artifact. Set expiresAt to null for no expiry. Anyone with the link can access it unless requireAuth is true.",
      inputSchema: createShareLinkInputSchema.extend({
        idempotencyKey: idempotencyKeySchema.optional(),
      }),
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
        () => {
          const { idempotencyKey, ...request } = args;
          return services.artifacts.createShareLink(
            identity,
            createShareLinkRequestSchema.parse(request),
            requireMcpIdempotencyKey(context, idempotencyKey),
          );
        },
      ),
  );

  server.registerTool(
    RELAY_MCP_TOOL_NAMES.revokeShareLink,
    {
      title: "Revoke a Relay artifact share link",
      description: "Revoke an existing workspace artifact share link.",
      inputSchema: revokeShareLinkInputSchema.extend({
        idempotencyKey: idempotencyKeySchema.optional(),
      }),
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
            requireMcpIdempotencyKey(context, args.idempotencyKey),
          ),
      ),
  );

  async function callExtension(
    name: RelayMcpManagementToolName,
    permanent: boolean,
    call: () => Promise<object>,
  ): Promise<CallToolResult> {
    const scopes = [
      ...RELAY_MCP_MANAGEMENT_TOOL_SCOPES[name],
      ...(permanent ? ["artifacts:share" as const] : []),
    ];
    if (!hasScopes(grantedScopes, scopes)) return missingScopeResult(scopes);
    try {
      const result = await call() as Record<string, unknown>;
      if (result.kind === "authorized") {
        return structuredResult(
          result,
          `${
            result.access === "permanent"
              ? "Permanent revocable link (anyone with this link can access the file)"
              : "Temporary download link"
          }: ${result.url}${
            result.expiresAt ? `\nExpires: ${result.expiresAt}` : ""
          }`,
        );
      }
      if (result.kind === "ok") {
        return structuredResult(
          result,
          "Email notification settings and recent delivery status returned. Settings apply to your own runs in this workspace.",
        );
      }
      if (result.kind === "not_configured") {
        return toolErrorResult(
          "dependency_unavailable",
          "Email notifications are not configured on this Relay instance.",
        );
      }
      if (result.kind === "quota_exceeded") {
        return toolErrorResult(
          "upload_quota_exceeded",
          "The workspace storage quota was exceeded.",
        );
      }
      if (result.kind === "idempotency_conflict") {
        return toolErrorResult(
          "idempotency_conflict",
          "This idempotency key was already used for different content or access settings.",
        );
      }
      if (result.kind === "storage_error" || result.kind === "pending") {
        return toolErrorResult(
          "dependency_unavailable",
          "Storage could not confirm the upload. Retry with the same idempotency key.",
          { retryable: true },
        );
      }
      if (result.kind === "not_found") {
        return toolErrorResult(
          "not_found",
          "The file or notification settings were not found.",
        );
      }
      return toolErrorResult(
        "invalid_request",
        "The requested operation is unavailable. Check the file and its access policy.",
      );
    } catch (error) {
      if (error instanceof McpInputError) {
        return toolErrorResult("invalid_request", IDEMPOTENCY_INPUT_MESSAGE, {
          details: { field: "idempotencyKey" },
        });
      }
      if (
        error instanceof TypeError || error instanceof RangeError ||
        error instanceof z.ZodError
      ) {
        return toolErrorResult(
          "invalid_request",
          "Check the tool arguments. Inline uploads support up to 4 MiB of canonical base64 or UTF-8 text.",
        );
      }
      return toolErrorResult(
        "internal_error",
        "Relay could not confirm the operation. Retry with the same idempotency key.",
        { retryable: true },
      );
    }
  }
  server.registerTool(
    RELAY_MCP_TOOL_NAMES.uploadContent,
    {
      title: "Save file content to Relay",
      description:
        "Persist actual file bytes (PDF, image, text or other content) in workspace storage and return an access URL. Accepts at most 4 MiB decoded base64 or UTF-8 text; no local paths, remote URLs or chat attachment IDs. If your client cannot read the attachment bytes, ask for a direct upload instead. Use create_upload/complete_upload for larger files. Defaults to a 5-minute URL; permanent access creates a revocable link readable by anyone who has it and requires artifacts:share. Supply a unique idempotencyKey argument and reuse it on retries.",
      inputSchema: uploadContentSchema.safeExtend({
        idempotencyKey: idempotencyKeySchema.optional(),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true },
      _meta: requiredScopeMetadata(
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[RELAY_MCP_TOOL_NAMES.uploadContent],
      ),
    },
    (args, context) =>
      callExtension(
        RELAY_MCP_TOOL_NAMES.uploadContent,
        args.access === "permanent",
        async () => {
          if (!services.content) return { kind: "not_found" };
          const { idempotencyKey, ...request } = args;
          return await services.content.upload(
            identity,
            request,
            requireMcpIdempotencyKey(context, idempotencyKey),
          );
        },
      ),
  );
  server.registerTool(
    RELAY_MCP_TOOL_NAMES.getAccess,
    {
      title: "Get a file access URL",
      description:
        "Get a URL for an uploaded file or saved tool output. Temporary URLs expire after 1–3600 seconds (default 300). Permanent links have no expiry, can be revoked, and are readable by anyone who has the link; they require artifacts:share and a unique idempotencyKey argument, reused on retries. Links remain valid while the stored file is retained.",
      inputSchema: contentAccessSchema.safeExtend({
        idempotencyKey: idempotencyKeySchema.optional(),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true },
      _meta: requiredScopeMetadata(
        RELAY_MCP_MANAGEMENT_TOOL_SCOPES[RELAY_MCP_TOOL_NAMES.getAccess],
      ),
    },
    (args, context) =>
      callExtension(
        RELAY_MCP_TOOL_NAMES.getAccess,
        args.access === "permanent",
        async () => {
          if (!services.content) return { kind: "not_found" };
          const { idempotencyKey, ...request } = args;
          return await services.content.access(
            identity,
            request,
            args.access === "permanent"
              ? requireMcpIdempotencyKey(context, idempotencyKey)
              : undefined,
          );
        },
      ),
  );
  server.registerTool(
    RELAY_MCP_TOOL_NAMES.getNotifications,
    {
      title: "Get email notification settings",
      description:
        "Read your opt-in settings and recent email delivery status for runs you create in this workspace.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: requiredScopeMetadata(["notifications:read"]),
    },
    () =>
      callExtension(
        RELAY_MCP_TOOL_NAMES.getNotifications,
        false,
        async () =>
          await services.notifications?.get(identity) ?? { kind: "not_found" },
      ),
  );
  server.registerTool(
    RELAY_MCP_TOOL_NAMES.configureNotifications,
    {
      title: "Configure email notifications",
      description:
        "Only call after the user explicitly asks to change email notifications. Choose whether to email the user's verified sign-in address when their runs complete or fail. Both settings start off; set both false to opt out. Applies to future runs in this workspace. Emails contain a sign-in link to the run, never prompts or attachments.",
      inputSchema: notificationSettingsSchema.extend({
        confirm: z.literal(true),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true },
      _meta: requiredScopeMetadata(["notifications:write"]),
    },
    (args) =>
      callExtension(
        RELAY_MCP_TOOL_NAMES.configureNotifications,
        false,
        async () =>
          await services.notifications?.update(identity, {
            completed: args.completed,
            failed: args.failed,
          }) ?? { kind: "not_found" },
      ),
  );

  if (grantedScopes.has("tools:execute")) {
    server.registerTool(
      RELAY_MCP_TOOL_NAMES.executeTool,
      {
        title: "Execute a Relay tool",
        description:
          "Run an image generation, image editing, OCR, or other catalog tool asynchronously. First use relay.tools.list to choose a tool and relay.tools.get to read its inputSchema. Supply schema-valid input and a unique idempotencyKey (a UUID); reuse the same key and arguments only when retrying the same operation. Optionally pin toolVersionId to the inspected activeVersionId. Poll relay.runs.get using the returned runId, then use relay.artifacts.get_access for result files. Execution requires workspace access and usage allowance.",
        inputSchema: executeToolInputSchema,
        outputSchema: executableToolResultSchema,
        annotations: { readOnlyHint: false, idempotentHint: true },
        _meta: requiredScopeMetadata(["tools:execute"]),
      },
      async (args, context) => {
        if (!grantedScopes.has("tools:execute")) {
          return missingScopeResult(["tools:execute"]);
        }
        try {
          if (MANAGEMENT_TOOL_NAME_SET.has(args.toolKey)) {
            return toolErrorResult(
              "invalid_request",
              "Use relay.tools.execute only for catalog tools. Call run, file, and administrative tools directly.",
              { details: { field: "toolKey" } },
            );
          }
          const resolved = getToolResultSchema.parse(
            await services.tools.get(identity, args.toolKey),
          );
          if (resolved.kind !== "found") {
            return executableError({ kind: "not_found" });
          }
          const tool = resolved.tool;
          if (
            args.toolVersionId && args.toolVersionId !== tool.activeVersionId
          ) {
            return toolErrorResult(
              "tool_unavailable",
              "The tool contract has changed. Read relay.tools.get again before executing.",
              { details: { toolKey: tool.key, reason: "version_changed" } },
            );
          }
          const inputError = await validateToolInput(tool, args.input);
          if (inputError) return inputError;
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
              suppliedKey: suppliedIdempotencyKey(context, args.idempotencyKey),
            }),
          );
          const request = createRunRequestSchema.parse({
            toolKey: tool.key,
            input: args.input,
            ...(args.requestedModelVersion === undefined
              ? {}
              : { requestedModelVersion: args.requestedModelVersion }),
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
          if (error instanceof McpInputError) {
            return toolErrorResult(
              "invalid_request",
              IDEMPOTENCY_INPUT_MESSAGE,
              { details: { field: "idempotencyKey" } },
            );
          }
          return toolErrorResult(
            "internal_error",
            "Relay could not confirm the run. Check relay.runs.list before retrying, and reuse the same idempotencyKey to avoid duplicate work.",
          );
        }
      },
    );
  }

  server.registerTool(RELAY_MCP_TOOL_NAMES.getStorageUsage, {
    title: "Get workspace storage usage",
    description:
      "Read stored bytes, upload reservations, cleanup debt, effective capacity and available space for the current workspace. Storage occupancy is distinct from billed tool usage.",
    inputSchema: z.object({}).strict(),
    outputSchema: fromJsonSchema(getStorageUsageResultSchema.jsonSchema),
    annotations: { readOnlyHint: true, idempotentHint: true },
    _meta: requiredScopeMetadata(["usage:read"]),
  }, () =>
    callManagementTool(
      grantedScopes,
      ["usage:read"],
      RELAY_MCP_TOOL_NAMES.getStorageUsage,
      getStorageUsageResultSchema,
      () => services.usage.getStorageSummary(identity),
    ));
  registerRelayAdminTools(server, options.adminServices, {
    adminSessionId: options.principal.adminSessionId,
    actorUserId: identity.actorUserId,
    scopes: options.principal.scopes,
  });
  return server;
}
