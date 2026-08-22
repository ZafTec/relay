import { withTransaction } from "@relay/database";
import type { DatabasePool } from "@relay/database";
import { generatePublicId, ID_PREFIXES } from "@relay/contracts";
import { recordAuditEvent } from "@relay/audit";
import { isSuperadmin } from "@relay/auth";
import {
  DEFAULT_HANDLER_VERSION,
  DEFAULT_INPUT_SCHEMA_VERSION,
  type HandlerCompatibility,
  type HandlerRegistry,
} from "./handlers.ts";

/**
 * "Every publish/disable/deprecate/retire/routing change is
 * system-superadmin only and audited" --
 * docs/implementation-handoff/05-domain-storage-metering.md "Tool
 * registry schema". Checked inside every mutating function here, not
 * left to callers, so the invariant holds regardless of which future
 * HTTP/MCP route ends up calling it.
 */
export type CatalogMutationResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "denied" };

export type ToolLifecycle =
  | "draft"
  | "internal"
  | "published"
  | "deprecated"
  | "retired"
  | "disabled";

/**
 * The lifecycle diagram from the doc: `draft -> internal -> published ->
 * deprecated -> retired`, with `published`/`deprecated` each able to
 * move to `disabled` and back. `retired` is terminal.
 */
const ALLOWED_TRANSITIONS: Record<ToolLifecycle, readonly ToolLifecycle[]> = {
  draft: ["internal"],
  internal: ["published"],
  published: ["deprecated", "disabled"],
  deprecated: ["retired", "disabled"],
  disabled: ["published", "deprecated"],
  retired: [],
};

type CatalogMutationExecutor = Pick<DatabasePool, "query">;

async function hasSuperadminAuthorization(
  queryable: CatalogMutationExecutor,
  actorUserId: string,
): Promise<boolean> {
  return await isSuperadmin(queryable, actorUserId);
}

export interface RegisterToolInput {
  readonly key: string;
  readonly name: string;
  readonly category?: string | null;
  readonly summary?: string | null;
  readonly visibility: string;
  readonly readinessCritical?: boolean;
}

export async function registerTool(
  pool: DatabasePool,
  actorUserId: string,
  input: RegisterToolInput,
): Promise<CatalogMutationResult<{ toolId: string }>> {
  return await withTransaction(pool, async (client) => {
    if (!await hasSuperadminAuthorization(client, actorUserId)) {
      return { kind: "denied" };
    }

    const toolId = generatePublicId(ID_PREFIXES.tool);
    await client.query(
      `insert into relay.tools
         (id, key, name, category, summary, lifecycle, visibility,
          readiness_critical)
       values ($1, $2, $3, $4, $5, 'draft', $6, $7)`,
      [
        toolId,
        input.key,
        input.name,
        input.category ?? null,
        input.summary ?? null,
        input.visibility,
        input.readinessCritical ?? false,
      ],
    );
    await recordAuditEvent(client, {
      actorType: "user",
      actorUserId,
      action: "tool.register",
      targetType: "tool",
      targetId: toolId,
      outcome: "success",
    });
    return { kind: "ok", value: { toolId } };
  });
}

export interface CreateToolVersionInput {
  readonly toolId: string;
  readonly inputSchema: unknown;
  readonly outputSchema: unknown;
  readonly handlerKey: string;
  readonly inputSchemaVersion?: number;
  readonly handlerVersion?: string;
  readonly executionMode: string;
  readonly maxDurationSeconds: number;
  readonly meterPolicyId?: string | null;
  readonly entitlementKey?: string | null;
  readonly compatibilityMetadata?: unknown;
}

export type ToolVersionContractField =
  | "toolId"
  | "inputSchema"
  | "outputSchema"
  | "handlerKey"
  | "inputSchemaVersion"
  | "handlerVersion"
  | "executionMode"
  | "maxDurationSeconds"
  | "meterPolicyId"
  | "entitlementKey"
  | "compatibilityMetadata";

interface SerializedToolVersionContract extends HandlerCompatibility {
  readonly inputSchema: string;
  readonly outputSchema: string;
  readonly compatibilityMetadata: string | null;
}

type ContractSerializationResult =
  | { readonly kind: "ok"; readonly value: SerializedToolVersionContract }
  | {
    readonly kind: "invalid";
    readonly field: ToolVersionContractField;
  };

type JsonSerializationResult =
  | { readonly kind: "ok"; readonly value: string }
  | {
    readonly kind: "invalid";
    readonly field: ToolVersionContractField;
  };

function serializeJsonContractField(
  value: unknown,
  field: ToolVersionContractField,
): JsonSerializationResult {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? { kind: "invalid", field }
      : { kind: "ok", value: serialized };
  } catch {
    return { kind: "invalid", field };
  }
}

function serializeToolVersionContract(
  input: CreateToolVersionInput,
): ContractSerializationResult {
  if (input.toolId.trim() === "") {
    return { kind: "invalid", field: "toolId" };
  }
  if (input.handlerKey.trim() === "") {
    return { kind: "invalid", field: "handlerKey" };
  }
  const inputSchemaVersion = input.inputSchemaVersion ??
    DEFAULT_INPUT_SCHEMA_VERSION;
  if (!Number.isSafeInteger(inputSchemaVersion) || inputSchemaVersion <= 0) {
    return { kind: "invalid", field: "inputSchemaVersion" };
  }
  const handlerVersion = input.handlerVersion ?? DEFAULT_HANDLER_VERSION;
  if (handlerVersion.trim() === "") {
    return { kind: "invalid", field: "handlerVersion" };
  }
  if (input.executionMode.trim() === "") {
    return { kind: "invalid", field: "executionMode" };
  }
  if (
    !Number.isSafeInteger(input.maxDurationSeconds) ||
    input.maxDurationSeconds <= 0
  ) {
    return { kind: "invalid", field: "maxDurationSeconds" };
  }
  if (
    input.meterPolicyId !== undefined && input.meterPolicyId !== null &&
    input.meterPolicyId.trim() === ""
  ) {
    return { kind: "invalid", field: "meterPolicyId" };
  }
  if (
    input.entitlementKey !== undefined && input.entitlementKey !== null &&
    input.entitlementKey.trim() === ""
  ) {
    return { kind: "invalid", field: "entitlementKey" };
  }

  const inputSchema = serializeJsonContractField(
    input.inputSchema,
    "inputSchema",
  );
  if (inputSchema.kind === "invalid") return inputSchema;
  const outputSchema = serializeJsonContractField(
    input.outputSchema,
    "outputSchema",
  );
  if (outputSchema.kind === "invalid") return outputSchema;

  let compatibilityMetadata: string | null = null;
  if (input.compatibilityMetadata !== undefined) {
    const serialized = serializeJsonContractField(
      input.compatibilityMetadata,
      "compatibilityMetadata",
    );
    if (serialized.kind === "invalid") return serialized;
    compatibilityMetadata = serialized.value;
  }

  return {
    kind: "ok",
    value: {
      inputSchema: inputSchema.value,
      outputSchema: outputSchema.value,
      inputSchemaVersion,
      handlerVersion,
      compatibilityMetadata,
    },
  };
}

export type CreateToolVersionResult =
  | { readonly kind: "denied" }
  | { readonly kind: "not_found" }
  | {
    readonly kind: "invalid_contract";
    readonly field: ToolVersionContractField;
  }
  | {
    readonly kind: "ok";
    readonly value: {
      readonly toolVersionId: string;
      readonly version: number;
    };
  };

export async function createToolVersion(
  pool: DatabasePool,
  actorUserId: string,
  input: CreateToolVersionInput,
): Promise<CreateToolVersionResult> {
  return await withTransaction(pool, async (client) => {
    if (!await hasSuperadminAuthorization(client, actorUserId)) {
      return { kind: "denied" };
    }

    const serialized = serializeToolVersionContract(input);
    if (serialized.kind === "invalid") {
      return { kind: "invalid_contract", field: serialized.field };
    }

    // Locks the tool row for the rest of this transaction -- without it,
    // two concurrent createToolVersion calls for the same tool both read
    // the same `max(version)` before either commits, both compute the
    // same next_version, and the second's insert throws a raw
    // unique-violation against tool_versions' (tool_id, version)
    // constraint instead of being handled. Locking here serializes them:
    // the second call blocks until the first commits, then re-reads
    // max(version) and sees the row that just landed. Also doubles as
    // the tool-exists check this function never had.
    const toolRows = await client.query(
      `select id from relay.tools where id = $1 for update`,
      [input.toolId],
    );
    if (toolRows.rows.length === 0) return { kind: "not_found" };

    const { rows } = await client.query<{ next_version: number }>(
      `select coalesce(max(version), 0) + 1 as next_version
       from relay.tool_versions where tool_id = $1`,
      [input.toolId],
    );
    const version = rows[0].next_version;
    const toolVersionId = generatePublicId(ID_PREFIXES.toolVersion);

    await client.query(
      `insert into relay.tool_versions
         (id, tool_id, version, input_schema, output_schema, handler_key,
          input_schema_version, handler_version, execution_mode,
          max_duration_seconds, meter_policy_id, entitlement_key,
          compatibility_metadata, immutable_hash)
       values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         relay.compute_tool_version_immutable_hash(
           $1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10,
           $11, $12, $13::jsonb
         )
       )`,
      [
        toolVersionId,
        input.toolId,
        version,
        serialized.value.inputSchema,
        serialized.value.outputSchema,
        input.handlerKey,
        serialized.value.inputSchemaVersion,
        serialized.value.handlerVersion,
        input.executionMode,
        input.maxDurationSeconds,
        input.meterPolicyId ?? null,
        input.entitlementKey ?? null,
        serialized.value.compatibilityMetadata,
      ],
    );
    await recordAuditEvent(client, {
      actorType: "user",
      actorUserId,
      action: "tool_version.create",
      targetType: "tool_version",
      targetId: toolVersionId,
      outcome: "success",
    });
    return { kind: "ok", value: { toolVersionId, version } };
  });
}

export type PublishToolVersionResult =
  | { readonly kind: "denied" }
  | { readonly kind: "unknown_handler"; readonly handlerKey: string }
  | {
    readonly kind: "incompatible_handler";
    readonly handlerKey: string;
    readonly expected: HandlerCompatibility;
    readonly registered: HandlerCompatibility;
  }
  | { readonly kind: "immutable_hash_mismatch" }
  | { readonly kind: "not_found" }
  | { readonly kind: "already_published" }
  | { readonly kind: "published" };

/**
 * "Unknown handlers make the tool version unavailable" is enforced here
 * as a hard publish-time gate, not only the doc's startup validation --
 * a version whose handler was never registered can never become the
 * active version in the first place. Publishing sets the version's own
 * `published_at` (never touched again -- versions are immutable once
 * published) and moves the *tool* to the `published` lifecycle with
 * this version as `active_version_id`, following `internal -> published`
 * (or re-publishing a later version while already `published`).
 */
export async function publishToolVersion(
  pool: DatabasePool,
  actorUserId: string,
  toolVersionId: string,
  handlers: HandlerRegistry,
): Promise<PublishToolVersionResult> {
  return await withTransaction(pool, async (client) => {
    if (!await hasSuperadminAuthorization(client, actorUserId)) {
      return { kind: "denied" };
    }

    const versionRows = await client.query<{
      tool_id: string;
      handler_key: string;
      input_schema_version: number;
      handler_version: string;
      published_at: Date | null;
      immutable_hash_valid: boolean;
    }>(
      `select tool_id, handler_key, input_schema_version, handler_version,
              published_at,
              immutable_hash = relay.compute_tool_version_immutable_hash(
                id, tool_id, version, input_schema, output_schema, handler_key,
                input_schema_version, handler_version, execution_mode,
                max_duration_seconds, meter_policy_id, entitlement_key,
                compatibility_metadata
              ) as immutable_hash_valid
       from relay.tool_versions
       where id = $1
       for update`,
      [toolVersionId],
    );
    if (versionRows.rows.length === 0) return { kind: "not_found" };
    const version = versionRows.rows[0];
    if (version.published_at !== null) return { kind: "already_published" };
    if (!version.immutable_hash_valid) {
      return { kind: "immutable_hash_mismatch" };
    }
    const registeredHandler = handlers.get(version.handler_key);
    if (registeredHandler === undefined) {
      return { kind: "unknown_handler", handlerKey: version.handler_key };
    }
    const expectedCompatibility: HandlerCompatibility = {
      inputSchemaVersion: version.input_schema_version,
      handlerVersion: version.handler_version,
    };
    if (!handlers.isCompatible(version.handler_key, expectedCompatibility)) {
      return {
        kind: "incompatible_handler",
        handlerKey: version.handler_key,
        expected: expectedCompatibility,
        registered: {
          inputSchemaVersion: registeredHandler.inputSchemaVersion,
          handlerVersion: registeredHandler.handlerVersion,
        },
      };
    }

    const toolRows = await client.query<{ lifecycle: ToolLifecycle }>(
      `select lifecycle from relay.tools where id = $1 for update`,
      [version.tool_id],
    );
    if (toolRows.rows.length === 0) return { kind: "not_found" };
    const currentLifecycle: ToolLifecycle = toolRows.rows[0].lifecycle;
    if (
      currentLifecycle !== "published" &&
      !ALLOWED_TRANSITIONS[currentLifecycle].includes("published")
    ) {
      return { kind: "denied" };
    }

    await client.query(
      `update relay.tool_versions set published_at = now() where id = $1`,
      [toolVersionId],
    );
    await client.query(
      `update relay.tools
         set lifecycle = 'published', active_version_id = $2, updated_at = now()
       where id = $1`,
      [version.tool_id, toolVersionId],
    );
    await recordAuditEvent(client, {
      actorType: "user",
      actorUserId,
      action: "tool_version.publish",
      targetType: "tool_version",
      targetId: toolVersionId,
      outcome: "success",
    });
    return { kind: "published" };
  });
}

export type SetToolLifecycleResult =
  | { readonly kind: "denied" }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid_transition"; readonly from: ToolLifecycle }
  | { readonly kind: "ok" };

export type SetToolReadinessCriticalResult =
  | { readonly kind: "denied" }
  | { readonly kind: "not_found" }
  | { readonly kind: "ok" };

/** Marks whether this tool's active published version gates process readiness. */
export async function setToolReadinessCritical(
  pool: DatabasePool,
  actorUserId: string,
  toolId: string,
  readinessCritical: boolean,
): Promise<SetToolReadinessCriticalResult> {
  return await withTransaction(pool, async (client) => {
    if (!await hasSuperadminAuthorization(client, actorUserId)) {
      return { kind: "denied" };
    }

    const { rows } = await client.query<{ readiness_critical: boolean }>(
      `select readiness_critical
         from relay.tools
        where id = $1
        for update`,
      [toolId],
    );
    if (rows.length === 0) return { kind: "not_found" };
    if (rows[0].readiness_critical === readinessCritical) {
      return { kind: "ok" };
    }

    await client.query(
      `update relay.tools
          set readiness_critical = $2, updated_at = now()
        where id = $1`,
      [toolId, readinessCritical],
    );
    await recordAuditEvent(client, {
      actorType: "user",
      actorUserId,
      action: "tool.readiness_critical.set",
      targetType: "tool",
      targetId: toolId,
      outcome: "success",
      beforeSnapshot: { readinessCritical: rows[0].readiness_critical },
      afterSnapshot: { readinessCritical },
    });
    return { kind: "ok" };
  });
}

/**
 * Every lifecycle move that isn't "publish a specific version" --
 * `draft -> internal`, `published/deprecated -> disabled`, `disabled ->`
 * back, `deprecated -> retired`. Rejects any move `ALLOWED_TRANSITIONS`
 * doesn't list, including publish (that always goes through
 * `publishToolVersion`, which also needs a version to activate).
 */
export async function setToolLifecycle(
  pool: DatabasePool,
  actorUserId: string,
  toolId: string,
  target: ToolLifecycle,
): Promise<SetToolLifecycleResult> {
  return await withTransaction(pool, async (client) => {
    if (!await hasSuperadminAuthorization(client, actorUserId)) {
      return { kind: "denied" };
    }

    const rows = await client.query<
      { lifecycle: ToolLifecycle; active_version_id: string | null }
    >(
      `select lifecycle, active_version_id from relay.tools where id = $1 for update`,
      [toolId],
    );
    if (rows.rows.length === 0) return { kind: "not_found" };
    const current: ToolLifecycle = rows.rows[0].lifecycle;
    if (!ALLOWED_TRANSITIONS[current].includes(target)) {
      return { kind: "invalid_transition", from: current };
    }
    // Reaching "published" for the first time (internal -> published) must
    // go through publishToolVersion, which is what actually sets
    // active_version_id -- setToolLifecycle only re-enables a tool that
    // already has one (the disabled -> published path).
    if (target === "published" && rows.rows[0].active_version_id === null) {
      return { kind: "invalid_transition", from: current };
    }

    await client.query(
      `update relay.tools set lifecycle = $2, updated_at = now() where id = $1`,
      [toolId, target],
    );
    await recordAuditEvent(client, {
      actorType: "user",
      actorUserId,
      action: `tool.lifecycle.${target}`,
      targetType: "tool",
      targetId: toolId,
      outcome: "success",
      beforeSnapshot: { lifecycle: current },
      afterSnapshot: { lifecycle: target },
    });
    return { kind: "ok" };
  });
}
