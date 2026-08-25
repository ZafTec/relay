export const NORMALIZED_ERROR_TYPES = [
  "aborted",
  "authentication",
  "authorization",
  "conflict",
  "dependency",
  "internal",
  "invalid_input",
  "not_found",
  "rate_limited",
  "timeout",
  "unavailable",
] as const;

export type NormalizedErrorType = typeof NORMALIZED_ERROR_TYPES[number];

export interface NormalizedError {
  readonly type: NormalizedErrorType;
  readonly message: string;
}

export interface NormalizeErrorOptions {
  /** A caller-selected bounded category; raw error names are never exported. */
  readonly type?: NormalizedErrorType;
}

const ERROR_MESSAGES: Readonly<Record<NormalizedErrorType, string>> = {
  aborted: "Operation aborted",
  authentication: "Authentication failed",
  authorization: "Operation denied",
  conflict: "Operation conflicted",
  dependency: "Dependency operation failed",
  internal: "Operation failed",
  invalid_input: "Input was invalid",
  not_found: "Resource was not found",
  rate_limited: "Operation was rate limited",
  timeout: "Operation timed out",
  unavailable: "Service was unavailable",
};

const ERROR_NAME_TYPES: Readonly<Record<string, NormalizedErrorType>> = {
  AbortError: "aborted",
  AuthenticationError: "authentication",
  AuthorizationError: "authorization",
  ConflictError: "conflict",
  DependencyError: "dependency",
  NotFoundError: "not_found",
  RateLimitError: "rate_limited",
  TimeoutError: "timeout",
  UnavailableError: "unavailable",
  ValidationError: "invalid_input",
};

export function isNormalizedErrorType(
  value: unknown,
): value is NormalizedErrorType {
  return typeof value === "string" &&
    (NORMALIZED_ERROR_TYPES as readonly string[]).includes(value);
}

function readErrorName(error: unknown): string | null {
  try {
    if (error === null || typeof error !== "object") return null;
    const name = Reflect.get(error, "name");
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

/**
 * Converts any thrown value to a fixed, bounded category and generic message.
 * Raw messages, causes, and stacks are intentionally never inspected or
 * returned because they routinely contain credentials and provider payloads.
 */
export function normalizeError(
  error: unknown,
  options: NormalizeErrorOptions = {},
): NormalizedError {
  const inferred = ERROR_NAME_TYPES[readErrorName(error) ?? ""] ?? "internal";
  const type = isNormalizedErrorType(options.type) ? options.type : inferred;
  return { type, message: ERROR_MESSAGES[type] };
}
