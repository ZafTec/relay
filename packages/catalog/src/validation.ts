import type { DatabasePool } from "@relay/database";
import type { HandlerRegistry } from "./handlers.ts";

/**
 * "A startup validation reports: Published versions with missing
 * handlers ... Do not fail the entire API for one disabled/
 * misconfigured draft tool." Only published versions are checked --
 * an unpublished draft with a typo'd `handler_key` is not yet serving
 * traffic and shouldn't block readiness.
 *
 * The doc also lists "Handler/schema-version mismatch", "Enabled
 * bindings with missing provider adapters", and "Invalid meter or
 * entitlement references" -- not implemented here. Schema-version
 * numbering, provider adapters, and meter/entitlement resolution don't
 * exist yet (Wave 5/metering), so there's nothing yet to check those
 * against.
 */
export interface CatalogValidationReport {
  readonly publishedVersionsWithMissingHandlers: readonly {
    readonly toolVersionId: string;
    readonly toolId: string;
    readonly handlerKey: string;
  }[];
}

export async function validateCatalogHandlers(
  pool: DatabasePool,
  handlers: HandlerRegistry,
): Promise<CatalogValidationReport> {
  const { rows } = await pool.query<
    { id: string; tool_id: string; handler_key: string }
  >(
    `select id, tool_id, handler_key from relay.tool_versions where published_at is not null`,
  );

  const missing = rows
    .filter((row: { handler_key: string }) => !handlers.has(row.handler_key))
    .map((row: { id: string; tool_id: string; handler_key: string }) => ({
      toolVersionId: row.id,
      toolId: row.tool_id,
      handlerKey: row.handler_key,
    }));

  return { publishedVersionsWithMissingHandlers: missing };
}
