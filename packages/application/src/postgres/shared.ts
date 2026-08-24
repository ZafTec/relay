import { getMembership } from "@relay/auth";
import type { DatabasePool } from "@relay/database";
import type { WorkspaceActorContext } from "../context.ts";

export type ApplicationDatabase = Pick<DatabasePool, "query">;

export async function hasCurrentMembership(
  database: ApplicationDatabase,
  context: WorkspaceActorContext,
): Promise<boolean> {
  return await getMembership(
    database,
    context.workspaceId,
    context.actorUserId,
  ) !== null;
}

export function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("database returned an invalid timestamp");
  }
  return date.toISOString();
}

export function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

export function jsonArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  }
  throw new TypeError("database returned a non-array JSON value");
}

export function assertSafeDatabaseNumber(
  value: string | number,
  field: string,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`database returned an invalid ${field}`);
  }
  return parsed;
}
