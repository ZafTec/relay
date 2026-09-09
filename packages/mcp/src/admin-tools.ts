import {
  type CallToolResult,
  fromJsonSchema,
  type JsonSchemaType,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import {
  adminChangelogDraftInputSchema,
  type ErrorCode,
  errorEnvelopeSchema,
  listAdminChangelogRequestSchema,
  RELAY_MCP_RESOURCE_SCOPES,
  type RelayMcpResourceScope,
} from "@relay/contracts";
import { suppliedIdempotencyKey } from "./idempotency.ts";

/** IDs in this context come only from the verified OAuth principal. */
export interface RelayMcpAdminContext {
  readonly sessionId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly idempotencyKey?: string;
}

export interface RelayMcpAdminServices {
  /** Recheck the current session, user and role on every call, including reads. */
  authorize(context: RelayMcpAdminContext): Promise<boolean>;
  invoke(
    operation: RelayMcpAdminOperation,
    context: RelayMcpAdminContext,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
}

const text = { type: "string", minLength: 1, maxLength: 255 } as const;
const nullableText = { type: ["string", "null"], maxLength: 255 } as const;
const timestamp = { type: "string", format: "date-time" } as const;
const nullableTimestamp = {
  type: ["string", "null"],
  format: "date-time",
} as const;
const revision = {
  type: "integer",
  minimum: 1,
  maximum: 2_147_483_646,
} as const;
const releaseId = { type: "string", pattern: "^[1-9][0-9]{0,18}$" } as const;
const scope = {
  scopeType: { type: "string", pattern: "^[a-z][a-z0-9_.-]{0,63}$" },
  scopeId: text,
} as const;
const clientFields = {
  client_name: { type: "string", minLength: 1, maxLength: 120 },
  redirect_uris: {
    type: "array",
    minItems: 1,
    maxItems: 10,
    uniqueItems: true,
    items: { type: "string", minLength: 1, maxLength: 2048 },
  },
  scopes: {
    type: "array",
    minItems: 1,
    maxItems: RELAY_MCP_RESOURCE_SCOPES.length,
    uniqueItems: true,
    items: { type: "string", enum: [...RELAY_MCP_RESOURCE_SCOPES] },
  },
  token_endpoint_auth_method: {
    type: "string",
    enum: ["none", "client_secret_post", "client_secret_basic"],
  },
} as const;

function object(
  properties: Record<string, unknown> = {},
  required: readonly string[] = [],
): JsonSchemaType {
  return {
    type: "object",
    additionalProperties: false,
    properties: properties as NonNullable<JsonSchemaType["properties"]>,
    required,
  };
}

export type RelayMcpAdminOperation =
  | "allowances.workspaces"
  | "allowances.get"
  | "allowances.grants"
  | "allowances.audit"
  | "allowances.grant"
  | "allowances.revoke"
  | "capacity.list"
  | "capacity.get"
  | "capacity.revise"
  | "superadmins.list"
  | "superadmins.invite"
  | "superadmins.revoke_invitation"
  | "changelog.list"
  | "changelog.get"
  | "changelog.create"
  | "changelog.revise"
  | "changelog.publish"
  | "changelog.unpublish"
  | "oauth.list"
  | "oauth.get"
  | "oauth.create"
  | "oauth.update"
  | "oauth.rotate"
  | "oauth.delete";

interface AdminDefinition {
  readonly operation: RelayMcpAdminOperation;
  readonly title: string;
  readonly description: string;
  readonly scope: RelayMcpResourceScope;
  readonly input: JsonSchemaType;
  readonly write?: boolean;
  readonly idempotent?: boolean;
}

const definitions: readonly AdminDefinition[] = [
  {
    operation: "allowances.workspaces",
    title: "Find workspaces for administration",
    description:
      "Find workspaces by name, memorable slug, ID or owner. Returns IDs for explicit allowance changes.",
    scope: "admin:allowances:read",
    input: object({
      search: { type: "string", maxLength: 128 },
      after: nullableText,
    }),
  },
  {
    operation: "allowances.get",
    title: "Get workspace allowances",
    description:
      "Inspect execution access, limits, consumed usage and remaining allowances for a workspace.",
    scope: "admin:allowances:read",
    input: object({ workspaceId: text }, ["workspaceId"]),
  },
  {
    operation: "allowances.grants",
    title: "List workspace allowance grants",
    description:
      "List active and historical grants for a workspace, with pagination.",
    scope: "admin:allowances:read",
    input: object({ workspaceId: text, before: nullableText }, ["workspaceId"]),
  },
  {
    operation: "allowances.audit",
    title: "Inspect allowance audit history",
    description: "Read the audited allowance changes for a workspace.",
    scope: "admin:allowances:read",
    input: object({ workspaceId: text, before: nullableText }, ["workspaceId"]),
  },
  {
    operation: "allowances.grant",
    title: "Grant an explicit workspace allowance",
    description:
      "Grant execution access or a finite/unlimited image or OCR allowance after the administrator requests it. This can authorize paid work.",
    scope: "admin:allowances:write",
    write: true,
    idempotent: true,
    input: object({
      workspaceId: text,
      key: {
        type: "string",
        enum: ["tools.execute", "images.generated", "ocr.requests"],
      },
      mode: { type: "string", enum: ["enabled", "finite", "unlimited"] },
      amount: { type: ["string", "null"], pattern: "^(0|[1-9][0-9]{0,28})$" },
      effectiveAt: nullableTimestamp,
      expiresAt: nullableTimestamp,
      reason: { type: "string", minLength: 1, maxLength: 1000 },
    }, [
      "workspaceId",
      "key",
      "mode",
      "amount",
      "effectiveAt",
      "expiresAt",
      "reason",
    ]),
  },
  {
    operation: "allowances.revoke",
    title: "Revoke a workspace allowance",
    description:
      "Revoke an explicit grant. New work may lose execution access or allowance.",
    scope: "admin:allowances:write",
    write: true,
    idempotent: true,
    input: object({
      workspaceId: text,
      grantId: text,
      reason: { type: "string", minLength: 1, maxLength: 1000 },
    }, ["workspaceId", "grantId", "reason"]),
  },
  {
    operation: "capacity.list",
    title: "List capacity policies",
    description: "Inspect current or historical execution capacity policies.",
    scope: "admin:capacity:read",
    input: object({
      ...scope,
      includeHistory: { type: "boolean" },
      effectiveAt: timestamp,
      limit: { type: "integer", minimum: 1, maximum: 1000 },
    }),
  },
  {
    operation: "capacity.get",
    title: "Get a capacity policy",
    description:
      "Read a capacity policy for an exact scope or historical revision.",
    scope: "admin:capacity:read",
    input: object({ ...scope, revision, effectiveAt: timestamp }, [
      "scopeType",
      "scopeId",
    ]),
  },
  {
    operation: "capacity.revise",
    title: "Revise a capacity policy",
    description:
      "Create an audited capacity revision. Requires the current revision (zero creates the first) and explicit effective time.",
    scope: "admin:capacity:write",
    write: true,
    idempotent: true,
    input: object({
      ...scope,
      expectedRevision: { ...revision, minimum: 0 },
      configuration: { type: "object", additionalProperties: true },
      effectiveAt: timestamp,
      expiresAt: nullableTimestamp,
    }, [
      "scopeType",
      "scopeId",
      "expectedRevision",
      "configuration",
      "effectiveAt",
    ]),
  },
  {
    operation: "superadmins.list",
    title: "List platform administrators and invitations",
    description: "Read current superadmin access and pending invitations.",
    scope: "admin:superadmins:read",
    input: object(),
  },
  {
    operation: "superadmins.invite",
    title: "Invite a platform administrator",
    description:
      "Create an invitation for a verified email address. Returns a link; no email is sent. The recipient must sign in and accept.",
    scope: "admin:superadmins:write",
    write: true,
    idempotent: true,
    input: object({
      email: { type: "string", format: "email", maxLength: 254 },
    }, ["email"]),
  },
  {
    operation: "superadmins.revoke_invitation",
    title: "Revoke a superadmin invitation",
    description: "Invalidate a pending invitation before it is accepted.",
    scope: "admin:superadmins:write",
    write: true,
    idempotent: true,
    input: object({
      invitationId: { type: "string", pattern: "^sinv_[0-9a-f]{32}$" },
    }, ["invitationId"]),
  },
  {
    operation: "changelog.list",
    title: "List platform changelog releases",
    description: "Read draft and published platform release entries.",
    scope: "admin:changelog:read",
    input: listAdminChangelogRequestSchema.jsonSchema as JsonSchemaType,
  },
  {
    operation: "changelog.get",
    title: "Get a platform changelog release",
    description: "Read a platform release and its revision history.",
    scope: "admin:changelog:read",
    input: object({ releaseId }, ["releaseId"]),
  },
  {
    operation: "changelog.create",
    title: "Create a changelog draft",
    description:
      "Create an audited draft. It remains unpublished until explicitly published.",
    scope: "admin:changelog:write",
    write: true,
    idempotent: true,
    input: object({ draft: adminChangelogDraftInputSchema.jsonSchema }, [
      "draft",
    ]),
  },
  {
    operation: "changelog.revise",
    title: "Revise a changelog draft",
    description:
      "Revise a draft using optimistic concurrency against its current revision.",
    scope: "admin:changelog:write",
    write: true,
    idempotent: true,
    input: object({
      releaseId,
      expectedRevision: revision,
      draft: adminChangelogDraftInputSchema.jsonSchema,
    }, ["releaseId", "expectedRevision", "draft"]),
  },
  {
    operation: "changelog.publish",
    title: "Publish a changelog release",
    description:
      "Publish the requested revision publicly after an explicit administrator instruction.",
    scope: "admin:changelog:write",
    write: true,
    idempotent: true,
    input: object({ releaseId, expectedRevision: revision }, [
      "releaseId",
      "expectedRevision",
    ]),
  },
  {
    operation: "changelog.unpublish",
    title: "Unpublish a changelog release",
    description: "Remove a published revision from the public changelog.",
    scope: "admin:changelog:write",
    write: true,
    idempotent: true,
    input: object({ releaseId, expectedPublishedRevision: revision }, [
      "releaseId",
      "expectedPublishedRevision",
    ]),
  },
  {
    operation: "oauth.list",
    title: "List managed OAuth clients",
    description:
      "List OAuth clients owned by the signed-in administrator. Secrets are not returned.",
    scope: "admin:oauth:read",
    input: object(),
  },
  {
    operation: "oauth.get",
    title: "Get a managed OAuth client",
    description:
      "Read an owned client's redirect and permission configuration without its secret.",
    scope: "admin:oauth:read",
    input: object({ client_id: text }, ["client_id"]),
  },
  {
    operation: "oauth.create",
    title: "Create a managed OAuth client",
    description:
      "Register a client with exact callback URLs, permissions and S256 PKCE. A confidential client's secret is returned once. The metadata key does not deduplicate this operation. Never retry an uncertain result; inspect the client list and ask the user before creating another.",
    scope: "admin:oauth:write",
    write: true,
    input: object(clientFields, [
      "client_name",
      "redirect_uris",
      "scopes",
      "token_endpoint_auth_method",
    ]),
  },
  {
    operation: "oauth.update",
    title: "Update a managed OAuth client",
    description:
      "Replace an owned client's name, redirects and allowed permissions. Review the requested changes before applying.",
    scope: "admin:oauth:write",
    write: true,
    input: object({
      client_id: text,
      client_name: clientFields.client_name,
      redirect_uris: clientFields.redirect_uris,
      scopes: clientFields.scopes,
    }, [
      "client_id",
      "client_name",
      "redirect_uris",
      "scopes",
    ]),
  },
  {
    operation: "oauth.rotate",
    title: "Rotate an OAuth client secret",
    description:
      "Invalidate the previous secret and return its replacement once. Update the agent configuration. The metadata key does not deduplicate rotation. Never retry an uncertain result; ask the user before rotating again.",
    scope: "admin:oauth:write",
    write: true,
    input: object({ client_id: text }, ["client_id"]),
  },
  {
    operation: "oauth.delete",
    title: "Delete a managed OAuth client",
    description:
      "Delete an owned client and revoke its authorizations. Connected agents lose access.",
    scope: "admin:oauth:write",
    write: true,
    input: object({ client_id: text }, ["client_id"]),
  },
];

export const RELAY_MCP_ADMIN_TOOL_SCOPES: Readonly<
  Record<string, readonly RelayMcpResourceScope[]>
> = Object.freeze(Object.fromEntries(
  definitions.map((definition) => [
    "relay.admin." + definition.operation,
    Object.freeze([definition.scope]),
  ]),
));

export function mcpAdminError(
  code: ErrorCode,
  message: string,
): CallToolResult {
  const envelope = errorEnvelopeSchema.parse({
    error: {
      code,
      message,
      retryable: false,
      requestId: "req_" + crypto.randomUUID(),
      details: {},
    },
  });
  return {
    content: [{ type: "text", text: message }],
    structuredContent: envelope,
    isError: true,
  };
}

function mutationKey(
  context: ServerContext,
  argumentKey?: unknown,
): string | undefined {
  try {
    if (argumentKey !== undefined && typeof argumentKey !== "string") {
      return undefined;
    }
    const value = suppliedIdempotencyKey(context, argumentKey);
    return typeof value === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export function registerRelayAdminTools(
  server: McpServer,
  services: RelayMcpAdminServices | undefined,
  principal: {
    readonly adminSessionId?: string;
    readonly actorUserId: string;
    readonly scopes: readonly string[];
  },
): void {
  if (!services || !principal.adminSessionId) return;
  const sessionId = principal.adminSessionId;
  for (const definition of definitions) {
    if (!principal.scopes.includes(definition.scope)) continue;
    server.registerTool("relay.admin." + definition.operation, {
      title: definition.title,
      description: definition.description +
        (definition.write
          ? " Requires a recently authenticated superadmin. Supply a unique idempotencyKey argument (a UUID) and reuse it with identical arguments when retrying."
          : ""),
      inputSchema: fromJsonSchema(
        definition.write
          ? {
            ...definition.input,
            properties: {
              ...definition.input.properties,
              idempotencyKey: {
                type: "string",
                minLength: 16,
                maxLength: 128,
                pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$",
                description:
                  "Unique key for this change. Reuse with identical arguments on retry. Required unless supplied in MCP metadata.",
              },
            },
          }
          : definition.input,
      ),
      annotations: {
        readOnlyHint: !definition.write,
        destructiveHint: definition.write === true,
        idempotentHint: !definition.write || definition.idempotent === true,
        openWorldHint: true,
      },
      _meta: { "io.relay/required-scopes": [definition.scope] },
    }, async (args, callContext) => {
      const { idempotencyKey: argumentKey, ...request } = args as Record<
        string,
        unknown
      >;
      const idempotencyKey = mutationKey(callContext, argumentKey);
      if (definition.write && !idempotencyKey) {
        return mcpAdminError(
          "invalid_request",
          "Supply a stable 16-128 character idempotencyKey argument for this administrative change. Reuse it on retries; argument and metadata keys must match if both are supplied.",
        );
      }
      const context: RelayMcpAdminContext = {
        sessionId,
        actorUserId: principal.actorUserId,
        requestId: "req_" + crypto.randomUUID(),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      };
      try {
        if (!await services.authorize(context)) {
          return mcpAdminError(
            "authorization_denied",
            "Current superadmin access is required.",
          );
        }
        const result = await services.invoke(
          definition.operation,
          context,
          request,
        );
        const structuredContent = { result };
        return {
          content: [{ type: "text", text: JSON.stringify(structuredContent) }],
          structuredContent,
        };
      } catch (error) {
        const code = error instanceof RelayMcpAdminError
          ? error.code
          : "internal_error";
        const message = error instanceof RelayMcpAdminError
          ? error.message
          : "The administrative operation could not be completed.";
        return mcpAdminError(code, message);
      }
    });
  }
}

/** Only fixed public messages belong in this error; never forward provider/SQL text. */
export class RelayMcpAdminError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}
