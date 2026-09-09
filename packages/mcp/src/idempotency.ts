import type { ServerContext } from "@modelcontextprotocol/server";
import { validateIdempotencyKey } from "@relay/application/context";
import { z } from "zod/v4";

export const RELAY_MCP_IDEMPOTENCY_META_KEY =
  "io.relay/idempotency-key" as const;

export const idempotencyKeySchema = z.string().min(1).max(255).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/,
).describe(
  "Generate a unique key (for example a UUID) for this operation. Reuse it with identical arguments when retrying; use a new key for a new operation.",
);

export class McpInputError extends TypeError {}

export function checkedIdempotencyKey(value: string): string {
  try {
    return validateIdempotencyKey(value);
  } catch {
    throw new McpInputError("The idempotency key has an invalid format.");
  }
}

/** Keep metadata-based integrations working while exposing keys to tool callers. */
export function suppliedIdempotencyKey(
  context: ServerContext,
  argumentKey?: string,
): string | undefined {
  const metadata = context.mcpReq._meta;
  if (metadata && Object.hasOwn(metadata, RELAY_MCP_IDEMPOTENCY_META_KEY)) {
    const value = metadata[RELAY_MCP_IDEMPOTENCY_META_KEY];
    if (typeof value !== "string") {
      throw new McpInputError("The idempotency key must be a string.");
    }
    checkedIdempotencyKey(value);
    if (argumentKey !== undefined && argumentKey !== value) {
      throw new McpInputError("Argument and metadata idempotency keys differ.");
    }
    return value;
  }
  return argumentKey === undefined
    ? undefined
    : checkedIdempotencyKey(argumentKey);
}

export function requireMcpIdempotencyKey(
  context: ServerContext,
  argumentKey?: string,
): string {
  const value = suppliedIdempotencyKey(context, argumentKey);
  if (value === undefined) {
    throw new McpInputError("An idempotency key is required.");
  }
  return checkedIdempotencyKey(value);
}

export const IDEMPOTENCY_INPUT_MESSAGE =
  "Provide idempotencyKey in the tool arguments (a unique UUID is suitable). Reuse the same key and arguments for retries. If metadata also supplies a key, both must match.";
