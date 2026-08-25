import type { AuthorizationFailure } from "./types.ts";
import { GovernanceIdempotencyConflictError } from "./crypto.ts";

export function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function authorizationFailure(
  error: unknown,
): AuthorizationFailure | undefined {
  const code = databaseErrorCode(error);
  if (code === "42501") return { kind: "denied", replayed: false };
  if (code === "28000" || code === "55000") {
    return { kind: "reauthentication_required", replayed: false };
  }
  return undefined;
}

export function throwMappedMutationError(error: unknown): never {
  if (databaseErrorCode(error) === "RG001") {
    throw new GovernanceIdempotencyConflictError();
  }
  throw error;
}
