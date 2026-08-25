export const MAX_SANITIZED_ERROR_LENGTH = 512;

const REDACTION_PATTERNS: readonly [RegExp, string][] = [
  [/\b(Bearer)\s+[^\s,;]+/gi, "$1 [REDACTED]"],
  [/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[REDACTED]@"],
  [
    /\b(password|passwd|secret|token|credential|authorization|cookie|api[-_]?key)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    "$1=[REDACTED]",
  ],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]"],
];

/**
 * Error text may be persisted and logged, so retain only a single bounded
 * message and scrub common credential forms. Stacks and arbitrary object
 * serialization are deliberately excluded.
 */
export function sanitizeError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  // deno-lint-ignore no-control-regex -- control characters are intentionally removed from persisted/logged errors.
  message = message.replace(/[\u0000-\u001f\u007f]+/g, " ");
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    message = message.replace(pattern, replacement);
  }
  message = message.replace(/\s+/g, " ").trim();
  if (message.length === 0) message = "Unknown error";
  return message.slice(0, MAX_SANITIZED_ERROR_LENGTH);
}

export interface BackoffOptions {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** A value from 0 through 1. A value of 0.2 randomizes by ±20%. */
  readonly jitterRatio: number;
}

export const DEFAULT_OUTBOX_BACKOFF: BackoffOptions = {
  baseDelayMs: 500,
  maxDelayMs: 60_000,
  jitterRatio: 0.2,
};

export function jitteredBackoffMs(
  attempt: number,
  options: BackoffOptions = DEFAULT_OUTBOX_BACKOFF,
  random: () => number = Math.random,
): number {
  const safeAttempt = Math.max(1, Math.trunc(attempt));
  const exponential = Math.min(
    options.maxDelayMs,
    options.baseDelayMs * 2 ** Math.min(safeAttempt - 1, 30),
  );
  const ratio = Math.min(1, Math.max(0, options.jitterRatio));
  const randomValue = Math.min(1, Math.max(0, random()));
  const factor = 1 - ratio + randomValue * ratio * 2;
  return Math.max(
    1,
    Math.min(options.maxDelayMs, Math.round(exponential * factor)),
  );
}
