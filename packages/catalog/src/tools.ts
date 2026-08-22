import { sha256Hex, withTransaction } from "@relay/database";
import type { DatabasePool } from "@relay/database";
import { generatePublicId, ID_PREFIXES } from "@relay/contracts";
import { isSuperadmin } from "@relay/auth";
import { recordAuditEvent } from "@relay/audit";
import type { HandlerRegistry } from "./handlers.ts";

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

export interface RegisterToolInput {
  readonly key: string;
  readonly name: string;
  readonly category?: string | null;
  readonly summary?: string | null;
  readonly visibility: string;
}

export async function registerTool(
  pool: DatabasePool,
  actorUserId: string,
  input: RegisterToolInput,
): Promise<CatalogMutationResult<{ toolId: string }>> {
  if (!await isSuperadmin(pool, actorUserId)) return { kind: "denied" };

  return await withTransaction(pool, async (client) => {
    const toolId = generatePublicId(ID_PREFIXES.tool);
    await client.query(
      `insert into relay.tools (id, key, name, category, summary, lifecycle, visibility)
       values ($1, $2, $3, $4, $5, 'draft', $6)`,
      [
        toolId,
        input.key,
        input.name,
        input.category ?? null,
        input.summary ?? null,
        input.visibility,
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
  readonly executionMode: string;
  readonly maxDurationSeconds: number;
  readonly meterPolicyId?: string | null;
  readonly entitlementKey?: string | null;
  readonly compatibilityMetadata?: unknown;
}

/**
 * `immutable_hash` covers everything that defines this version's
 * observable contract (schemas, handler, execution mode, duration) --
 * a later audit can confirm a published version's behavior-defining
 * fields never silently changed after publish, since publish never
 * updates this row again.
 */
async function computeImmutableHash(
  input: CreateToolVersionInput,
): Promise<string> {
  return await sha256Hex(JSON.stringify({
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    handlerKey: input.handlerKey,
    executionMode: input.executionMode,
    maxDurationSeconds: input.maxDurationSeconds,
  }));
}

export type CreateToolVersionResult =
  | { readonly kind: "denied" }
  | { readonly kind: "not_found" }
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
  if (!await isSuperadmin(pool, actorUserId)) return { kind: "denied" };

  return await withTransaction(pool, async (client) => {
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
    const immutableHash = await computeImmutableHash(input);

    await client.query(
      `insert into relay.tool_versions
         (id, tool_id, version, input_schema, output_schema, handler_key,
          execution_mode, max_duration_seconds, meter_policy_id,
          entitlement_key, compatibility_metadata, immutable_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        toolVersionId,
        input.toolId,
        version,
        JSON.stringify(input.inputSchema),
        JSON.stringify(input.outputSchema),
        input.handlerKey,
        input.executionMode,
        input.maxDurationSeconds,
        input.meterPolicyId ?? null,
        input.entitlementKey ?? null,
        input.compatibilityMetadata === undefined
          ? null
          : JSON.stringify(input.compatibilityMetadata),
        immutableHash,
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
  if (!await isSuperadmin(pool, actorUserId)) return { kind: "denied" };

  return await withTransaction(pool, async (client) => {
    const versionRows = await client.query<
      { tool_id: string; handler_key: string; published_at: Date | null }
    >(
      `select tool_id, handler_key, published_at from relay.tool_versions where id = $1 for update`,
      [toolVersionId],
    );
    if (versionRows.rows.length === 0) return { kind: "not_found" };
    const version = versionRows.rows[0];
    if (version.published_at !== null) return { kind: "already_published" };
    if (!handlers.has(version.handler_key)) {
      return { kind: "unknown_handler", handlerKey: version.handler_key };
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
  if (!await isSuperadmin(pool, actorUserId)) return { kind: "denied" };

  return await withTransaction(pool, async (client) => {
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
