import { type HandlerRegistry, resolveCatalogRoute } from "@relay/catalog";
import {
  type GetToolResult,
  type ListToolsRequest,
  listToolsRequestSchema,
  type ListToolsResult,
  listToolsResultSchema,
  PUBLIC_ID_PATTERNS,
  TOOL_KEY_PATTERN,
  type ToolDetail,
  toolDetailSchema,
  type ToolSummary,
  toolSummarySchema,
} from "@relay/contracts";
import type { DatabasePool } from "@relay/database";
import type { WorkspaceActorContext } from "../context.ts";
import { validateWorkspaceActorContext } from "../context.ts";
import { decodeCursor, encodeCursor, InvalidCursorError } from "../cursor.ts";
import type { ToolApplicationService } from "../services.ts";
import { filterSignature } from "./filter.ts";
import { hasCurrentMembership } from "./shared.ts";

interface ToolRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly category: string | null;
  readonly summary: string | null;
  readonly lifecycle: "published" | "deprecated";
  readonly active_version_id: string;
  readonly version: number;
  readonly input_schema?: unknown;
  readonly output_schema?: unknown;
  readonly execution_mode?: string;
  readonly max_duration_seconds?: number;
  readonly handler_key: string;
  readonly input_schema_version: number;
  readonly handler_version: string;
}

function summaryFromRow(row: ToolRow): ToolSummary {
  return toolSummarySchema.parse({
    id: row.id,
    key: row.key,
    name: row.name,
    category: row.category,
    summary: row.summary,
    lifecycle: row.lifecycle,
    activeVersionId: row.active_version_id,
    version: row.version,
  });
}

function detailFromRow(row: ToolRow): ToolDetail {
  return toolDetailSchema.parse({
    ...summaryFromRow(row),
    executionMode: row.execution_mode,
    maxDurationSeconds: row.max_duration_seconds,
    inputSchema: row.input_schema,
    outputSchema: row.output_schema,
  });
}

function validateToolKey(toolKey: string): string {
  if (!TOOL_KEY_PATTERN.test(toolKey) || toolKey.length > 128) {
    throw new TypeError("toolKey has an invalid format");
  }
  return toolKey;
}

interface HandlerPredicate {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function handlerPredicate(
  handlers: HandlerRegistry,
  firstParameter: number,
): HandlerPredicate | null {
  const registrations = [...handlers.keys]
    .sort()
    .map((key) => handlers.get(key))
    .filter((registration) => registration !== undefined);
  if (registrations.length === 0) return null;

  const params: unknown[] = [];
  const clauses = registrations.map((registration, index) => {
    const offset = firstParameter + index * 3;
    params.push(
      registration.key,
      registration.inputSchemaVersion,
      registration.handlerVersion,
    );
    return `(tv.handler_key = $${offset}
      and tv.input_schema_version = $${offset + 1}
      and tv.handler_version = $${offset + 2})`;
  });
  return { sql: `(${clauses.join(" or ")})`, params };
}

function availabilitySql(): string {
  return `
    and t.visibility = 'public'
    and t.lifecycle in ('published', 'deprecated')
    and tv.id = t.active_version_id
    and tv.published_at is not null
    and tv.retired_at is null
    and tv.immutable_hash = relay.compute_tool_version_immutable_hash(
      tv.id, tv.tool_id, tv.version, tv.input_schema, tv.output_schema,
      tv.handler_key, tv.input_schema_version, tv.handler_version,
      tv.execution_mode, tv.max_duration_seconds, tv.meter_policy_id,
      tv.entitlement_key, tv.compatibility_metadata
    )
    and exists (
      select 1
        from relay.tool_provider_bindings binding
        join relay.provider_models model on model.id = binding.provider_model_id
        join relay.providers provider on provider.id = model.provider_id
        join relay.capacity_pools pool on pool.id = binding.capacity_pool_id
        left join relay.routing_policies policy on policy.id = binding.routing_policy_id
       where binding.tool_version_id = tv.id
         and binding.enabled = true
         and model.lifecycle not in ('disabled', 'retired')
         and provider.lifecycle not in ('disabled', 'retired')
         and pool.enabled = true
         and (pool.provider_model_id is null or pool.provider_model_id = model.id)
         and (policy.id is null or (
           policy.effective_at <= now()
           and policy.immutable_hash = relay.compute_routing_policy_immutable_hash(
             policy.id, policy.revision, policy.policy, policy.effective_at
           )
         ))
    )`;
}

export class PostgresToolService implements ToolApplicationService {
  readonly #pool: DatabasePool;
  readonly #handlers: HandlerRegistry;

  constructor(pool: DatabasePool, handlers: HandlerRegistry) {
    if (handlers === undefined || handlers === null) {
      throw new TypeError("handlers is required");
    }
    this.#pool = pool;
    this.#handlers = handlers;
  }

  async list(
    rawContext: WorkspaceActorContext,
    rawRequest: ListToolsRequest,
  ): Promise<ListToolsResult> {
    const context = validateWorkspaceActorContext(rawContext);
    const request = listToolsRequestSchema.parse(rawRequest);
    if (!await hasCurrentMembership(this.#pool, context)) {
      return { kind: "not_found" };
    }

    const compatibleHandlers = handlerPredicate(this.#handlers, 7);
    if (compatibleHandlers === null) {
      return { kind: "ok", items: [], nextCursor: null };
    }

    const filter = filterSignature([
      ["category", request.category ?? null],
      ["search", request.search ?? null],
    ]);
    let cursorKey: string | null = null;
    let cursorId: string | null = null;
    if (request.cursor !== null) {
      const position = decodeCursor(request.cursor, "tools", filter, 2);
      if (
        !TOOL_KEY_PATTERN.test(position[0]) ||
        !PUBLIC_ID_PATTERNS.tool.test(position[1])
      ) {
        throw new InvalidCursorError("tool cursor position is invalid");
      }
      [cursorKey, cursorId] = position;
    }

    const params: unknown[] = [
      context.workspaceId,
      context.actorUserId,
      request.category ?? null,
      request.search ?? null,
      cursorKey,
      cursorId,
      ...compatibleHandlers.params,
    ];
    const limitParameter = params.length + 1;
    params.push(request.limit + 1);
    const { rows } = await this.#pool.query<ToolRow>(
      `select t.id, t.key, t.name, t.category, t.summary, t.lifecycle,
              t.active_version_id, tv.version, tv.handler_key,
              tv.input_schema_version, tv.handler_version
         from relay.tools t
         join relay.tool_versions tv on tv.id = t.active_version_id
        where exists (
          select 1 from auth.member member
           where member."organizationId" = $1 and member."userId" = $2
        )
          ${availabilitySql()}
          and ($3::text is null or t.category = $3)
          and ($4::text is null or position(lower($4) in lower(
            t.key || ' ' || t.name || ' ' || coalesce(t.summary, '')
          )) > 0)
          and ($5::text is null or (t.key, t.id) > ($5, $6))
          and ${compatibleHandlers.sql}
        order by t.key asc, t.id asc
        limit $${limitParameter}`,
      params,
    );
    const hasMore = rows.length > request.limit;
    const selected = rows.slice(0, request.limit);
    const items = selected.map(summaryFromRow);
    const last = selected.at(-1);
    return listToolsResultSchema.parse({
      kind: "ok",
      items,
      nextCursor: hasMore && last !== undefined
        ? encodeCursor("tools", filter, [last.key, last.id])
        : null,
    });
  }

  async get(
    rawContext: WorkspaceActorContext,
    rawToolKey: string,
  ): Promise<GetToolResult> {
    const context = validateWorkspaceActorContext(rawContext);
    const toolKey = validateToolKey(rawToolKey);
    const { rows } = await this.#pool.query<ToolRow>(
      `select t.id, t.key, t.name, t.category, t.summary, t.lifecycle,
              t.active_version_id, tv.version, tv.input_schema,
              tv.output_schema, tv.execution_mode, tv.max_duration_seconds,
              tv.handler_key, tv.input_schema_version, tv.handler_version
         from relay.tools t
         join relay.tool_versions tv on tv.id = t.active_version_id
        where t.key = $3
          and exists (
            select 1 from auth.member member
             where member."organizationId" = $1 and member."userId" = $2
          )
          ${availabilitySql()}`,
      [context.workspaceId, context.actorUserId, toolKey],
    );
    const row = rows[0];
    if (row === undefined) return { kind: "not_found" };
    const route = await resolveCatalogRoute(
      this.#pool,
      this.#handlers,
      row.active_version_id,
    );
    if (route.kind === "unavailable") return { kind: "not_found" };
    return { kind: "found", tool: detailFromRow(row) };
  }
}
