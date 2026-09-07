import type { DatabasePool } from "@relay/database";
import {
  AllowanceInputError,
  parseGrantAllowanceInput,
  parseRevokeAllowanceInput,
} from "@relay/metering";
import {
  canonicalCapacityPolicyJson,
  type CapacityPolicyConfiguration,
  type GetCapacityPolicyInput,
  type ListCapacityPoliciesOptions,
} from "@relay/catalog";
import {
  adminChangelogDraftInputSchema,
  ContractValidationError,
  listAdminChangelogRequestSchema,
} from "@relay/contracts";
import {
  type RelayMcpAdminContext,
  RelayMcpAdminError,
  type RelayMcpAdminOperation,
  type RelayMcpAdminServices,
} from "@relay/mcp";
import type { AdminAllowanceService } from "../routes/admin_allowances.ts";
import type { AdminCapacityService } from "../routes/admin_capacity.ts";
import type { AdminChangelogService } from "../routes/admin_changelog.ts";
import type { SuperadminAccessService } from "../routes/admin_access.ts";

export type McpOAuthClientOperation =
  | "list"
  | "get"
  | "create"
  | "update"
  | "rotate"
  | "delete";

export interface McpAdminDependencies {
  readonly pool: DatabasePool;
  readonly publicOrigin: string;
  readonly allowances: AdminAllowanceService;
  readonly capacity: AdminCapacityService;
  readonly changelog: AdminChangelogService;
  readonly superadmins: SuperadminAccessService;
  readonly oauth: (
    sessionId: string,
    actorUserId: string,
    operation: McpOAuthClientOperation,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
}

function fixedError(error: unknown): RelayMcpAdminError {
  if (error instanceof RelayMcpAdminError) return error;
  const record = typeof error === "object" && error !== null
    ? error as {
      code?: unknown;
      name?: unknown;
      status?: unknown;
      body?: unknown;
    }
    : {};
  const bodyCode = typeof record.body === "object" && record.body !== null &&
      "code" in record.body
    ? record.body.code
    : undefined;
  if (bodyCode === "SESSION_TOO_OLD") {
    return new RelayMcpAdminError(
      "reauthentication_required",
      "Sign in again and reconnect the agent before changing platform settings.",
    );
  }
  // Better Auth also uses UNAUTHORIZED for a foreign client's ownership check;
  // the signed administrative session is verified before native dispatch.
  if (
    record.code === "42501" || record.status === "FORBIDDEN" ||
    record.status === "UNAUTHORIZED"
  ) {
    return new RelayMcpAdminError(
      "authorization_denied",
      "Current superadmin access and ownership are required.",
    );
  }
  if (["28000", "55000"].includes(String(record.code))) {
    return new RelayMcpAdminError(
      "reauthentication_required",
      "Sign in again and reconnect the agent before changing platform settings.",
    );
  }
  if (
    record.code === "RG001" ||
    record.name === "GovernanceIdempotencyConflictError"
  ) {
    return new RelayMcpAdminError(
      "idempotency_conflict",
      "The idempotency key was already used for different input.",
    );
  }
  if (record.code === "RA404" || record.status === "NOT_FOUND") {
    return new RelayMcpAdminError(
      "not_found",
      "The administrative resource was not found.",
    );
  }
  if (
    error instanceof AllowanceInputError ||
    error instanceof ContractValidationError ||
    record.name === "CapacityPolicyValidationError" ||
    ["22023", "22007", "22008", "RA409"].includes(String(record.code)) ||
    record.status === "BAD_REQUEST"
  ) {
    return new RelayMcpAdminError(
      "invalid_request",
      "The requested settings are invalid or have changed. Refresh the resource before trying again.",
    );
  }
  return new RelayMcpAdminError(
    "internal_error",
    "The administrative operation could not be completed.",
  );
}

function successful(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return value;
  }
  switch (value.kind) {
    case "denied":
      throw new RelayMcpAdminError(
        "authorization_denied",
        "Current superadmin access is required.",
      );
    case "reauthentication_required":
      throw new RelayMcpAdminError(
        "reauthentication_required",
        "Sign in again and reconnect the agent before changing platform settings.",
      );
    case "not_found":
      throw new RelayMcpAdminError(
        "not_found",
        "The administrative resource was not found.",
      );
    case "idempotency_conflict":
    case "mutation_key_conflict":
      throw new RelayMcpAdminError(
        "idempotency_conflict",
        "The idempotency key was already used for different input.",
      );
    case "revision_conflict":
    case "conflict":
    case "identity_locked":
    case "not_publishable":
      throw new RelayMcpAdminError(
        "invalid_request",
        "The resource changed or cannot be published. Read its current state before trying again.",
      );
    default:
      return value;
  }
}

function key(context: RelayMcpAdminContext): string {
  if (
    !context.idempotencyKey ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(context.idempotencyKey)
  ) {
    throw new RelayMcpAdminError(
      "invalid_request",
      "A stable administrative idempotency key is required.",
    );
  }
  return context.idempotencyKey;
}

async function invitationId(context: RelayMcpAdminContext): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify([
          "relay-mcp-invitation:v1",
          context.actorUserId,
          key(context),
        ]),
      ),
    ),
  );
  return "sinv_" +
    Array.from(
      digest.slice(0, 16),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
}

/** Reuses the HTTP administration services and their transaction/audit boundaries. */
export function createMcpAdminServices(
  dependencies: McpAdminDependencies,
): RelayMcpAdminServices {
  async function invoke(
    operation: RelayMcpAdminOperation,
    context: RelayMcpAdminContext,
    input: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const session = { sessionId: context.sessionId };
    const workspaceId = input.workspaceId as string;
    switch (operation) {
      case "allowances.workspaces":
        return dependencies.allowances.workspaces(
          context.sessionId,
          input.search as string ?? "",
          input.after as string ?? null,
        );
      case "allowances.get": {
        const result = await dependencies.allowances.summary(
          context.sessionId,
          workspaceId,
        );
        if (!result) {
          throw new RelayMcpAdminError(
            "not_found",
            "The workspace was not found.",
          );
        }
        return result;
      }
      case "allowances.grants":
        return dependencies.allowances.grants(
          context.sessionId,
          workspaceId,
          input.before as string ?? null,
        );
      case "allowances.audit":
        return dependencies.allowances.audit(
          context.sessionId,
          workspaceId,
          input.before as string ?? null,
        );
      case "allowances.grant": {
        const { workspaceId: _, ...grant } = input;
        return dependencies.allowances.mutate(
          context.sessionId,
          workspaceId,
          "grant",
          parseGrantAllowanceInput(grant),
          key(context),
          context.requestId,
        );
      }
      case "allowances.revoke":
        return dependencies.allowances.mutate(
          context.sessionId,
          workspaceId,
          "revoke",
          parseRevokeAllowanceInput({
            grantId: input.grantId,
            reason: input.reason,
          }),
          key(context),
          context.requestId,
        );
      case "capacity.list":
        return dependencies.capacity.list(
          session,
          {
            ...input,
            requestId: context.requestId,
          } as ListCapacityPoliciesOptions,
        );
      case "capacity.get":
        return dependencies.capacity.get(
          session,
          {
            ...input,
            requestId: context.requestId,
          } as unknown as GetCapacityPolicyInput,
        );
      case "capacity.revise":
        return dependencies.capacity.revise(session, {
          scopeType: input.scopeType as string,
          scopeId: input.scopeId as string,
          expectedRevision: input.expectedRevision as number,
          configuration: JSON.parse(
            canonicalCapacityPolicyJson(input.configuration),
          ) as CapacityPolicyConfiguration,
          effectiveAt: input.effectiveAt as string,
          expiresAt: input.expiresAt as string ?? null,
          mutationKey: key(context),
          requestId: context.requestId,
        });
      case "superadmins.list":
        return dependencies.superadmins.list(context.sessionId);
      case "superadmins.invite": {
        const id = await invitationId(context);
        const invitation = successful(
          await dependencies.superadmins.invite(
            context.sessionId,
            id,
            (input.email as string).trim().toLowerCase(),
          ),
        );
        if (
          typeof invitation !== "object" || invitation === null ||
          !("id" in invitation) || typeof invitation.id !== "string" ||
          !/^sinv_[0-9a-f]{32}$/.test(invitation.id)
        ) throw new Error("Invalid invitation result");
        return {
          invitation,
          url: new URL(
            `/superadmin-invitations/${invitation.id}`,
            dependencies.publicOrigin,
          ).href,
        };
      }
      case "superadmins.revoke_invitation":
        return dependencies.superadmins.revoke(
          context.sessionId,
          input.invitationId as string,
        );
      case "changelog.list":
        return dependencies.changelog.list(
          session,
          listAdminChangelogRequestSchema.parse(input),
        );
      case "changelog.get":
        return dependencies.changelog.get(session, input.releaseId as string);
      case "changelog.create":
        return dependencies.changelog.create({
          ...session,
          idempotencyKey: key(context),
          requestId: context.requestId,
        }, adminChangelogDraftInputSchema.parse(input.draft));
      case "changelog.revise":
        return dependencies.changelog.revise(
          {
            ...session,
            idempotencyKey: key(context),
            requestId: context.requestId,
          },
          input.releaseId as string,
          input.expectedRevision as number,
          adminChangelogDraftInputSchema.parse(input.draft),
        );
      case "changelog.publish":
        return dependencies.changelog.publish(
          {
            ...session,
            idempotencyKey: key(context),
            requestId: context.requestId,
          },
          input.releaseId as string,
          input.expectedRevision as number,
        );
      case "changelog.unpublish":
        return dependencies.changelog.unpublish(
          {
            ...session,
            idempotencyKey: key(context),
            requestId: context.requestId,
          },
          input.releaseId as string,
          input.expectedPublishedRevision as number,
        );
      case "oauth.list":
      case "oauth.get":
      case "oauth.create":
      case "oauth.update":
      case "oauth.rotate":
      case "oauth.delete": {
        const method = operation.slice(
          "oauth.".length,
        ) as McpOAuthClientOperation;
        const { scopes, ...fields } = input;
        const prepared = scopes === undefined ? fields : {
          ...fields,
          scope: ["openid", "offline_access", ...(scopes as string[])].join(
            " ",
          ),
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        };
        return dependencies.oauth(
          context.sessionId,
          context.actorUserId,
          method,
          prepared,
        );
      }
    }
  }
  return {
    async authorize(context) {
      const result = await dependencies.pool.query<{ allowed: boolean }>(
        `select exists (
          select 1 from auth.session s
          join auth."user" u on u.id=s."userId" and u."emailVerified" is true
          join relay.system_role_assignments r on r.user_id=u.id and r.revoked_at is null
          where s.id=$1 and s."userId"=$2 and s."expiresAt">now()
        ) as allowed`,
        [context.sessionId, context.actorUserId],
      );
      return result.rows[0]?.allowed === true;
    },
    async invoke(operation, context, input) {
      try {
        return successful(await invoke(operation, context, input));
      } catch (error) {
        throw fixedError(error);
      }
    },
  };
}
