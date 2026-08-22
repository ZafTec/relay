/** Satisfied by both `pg.Pool` and a checked-out `pg.PoolClient`. */
export interface Queryable {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export type AuditActorType = "user" | "system" | "oauth_client";
export type AuditOutcome = "success" | "failure" | "denied";

export interface AuditEventInput {
  readonly actorType: AuditActorType;
  readonly actorUserId?: string | null;
  readonly oauthClientId?: string | null;
  readonly workspaceId?: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId?: string | null;
  readonly outcome: AuditOutcome;
  readonly reasonCode?: string | null;
  readonly beforeSnapshot?: unknown;
  readonly afterSnapshot?: unknown;
  readonly requestId?: string | null;
  readonly traceId?: string | null;
  readonly ipHashOrPolicyValue?: string | null;
  readonly userAgentSummary?: string | null;
  readonly idempotencyKey?: string | null;
}

export const AUDIT_REDACTION_LIMITS = {
  maxDepth: 8,
  maxCollectionEntries: 64,
  maxNodes: 512,
  maxStringCharacters: 4_096,
  maxTotalStringCharacters: 32_768,
} as const;

const REDACTED = "[redacted]";
const TRUNCATED = "[truncated]";
const CIRCULAR = "[circular]";
const UNSUPPORTED = "[unsupported]";
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

const SENSITIVE_KEY_PATTERN =
  /password|passphrase|secret|token|credential|authorization|cookie|api[-_]?key|private[-_]?key|client[-_]?secret|oauth[-_]?code|signed[-_]?url/i;
const SENSITIVE_ASSIGNMENT_PATTERN =
  /(?:password|passphrase|secret|token|credential|authorization|cookie|api[-_]?key|private[-_]?key|client[-_]?secret|oauth[-_]?code)\s*[:=]\s*[^\s,;]+/i;
const AUTHORIZATION_VALUE_PATTERN = /(?:^|\s)(?:bearer|basic)\s+\S+/i;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/;
const TOKEN_PREFIX_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16})\b/;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const URL_PATTERN = /(?:https?|postgres(?:ql)?|redis):\/\/[^\s"'<>]+/gi;
const SENSITIVE_QUERY_PARAMETER_PATTERN =
  /^(?:code|state|signature|sig|key|x-amz-.+)$/i;

interface NormalizationState {
  readonly seen: WeakSet<object>;
  nodes: number;
  stringCharacters: number;
}

type NormalizationMode = "redact" | "fingerprint";

export class AuditIdempotencyConflictError extends Error {
  override readonly name = "AuditIdempotencyConflictError";

  constructor() {
    super("Audit idempotency key was reused with a different event");
  }
}

/**
 * Produces JSON-safe audit data while enforcing resource bounds. Sensitive
 * field names remain intact so the resulting snapshot keeps its schema, while
 * their values and credential-shaped keys/strings are replaced before storage.
 */
export function redactAuditValue(value: unknown): unknown {
  return normalizeAuditValue(value, 0, newNormalizationState(), "redact");
}

function fingerprintAuditValue(value: unknown): unknown {
  return normalizeAuditValue(value, 0, newNormalizationState(), "fingerprint");
}

function newNormalizationState(): NormalizationState {
  return {
    seen: new WeakSet(),
    nodes: 0,
    stringCharacters: 0,
  };
}

function normalizeAuditValue(
  value: unknown,
  depth: number,
  state: NormalizationState,
  mode: NormalizationMode,
): unknown {
  if (state.nodes >= AUDIT_REDACTION_LIMITS.maxNodes) return TRUNCATED;
  state.nodes += 1;

  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    return mode === "redact"
      ? redactString(value, state)
      : boundedString(value, state);
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return boundedString(value.toString(), state);
  if (typeof value !== "object") return UNSUPPORTED;
  if (depth >= AUDIT_REDACTION_LIMITS.maxDepth) return TRUNCATED;
  if (state.seen.has(value)) return CIRCULAR;
  state.seen.add(value);

  if (value instanceof Date) {
    return Number.isFinite(value.getTime())
      ? boundedString(value.toISOString(), state)
      : null;
  }

  if (Array.isArray(value)) {
    const result = value.slice(0, AUDIT_REDACTION_LIMITS.maxCollectionEntries)
      .map((item) => normalizeAuditValue(item, depth + 1, state, mode));
    if (value.length > AUDIT_REDACTION_LIMITS.maxCollectionEntries) {
      result.push(TRUNCATED);
    }
    return result;
  }

  let entries: [string, unknown][];
  try {
    entries = Object.entries(value as Record<string, unknown>);
  } catch {
    return UNSUPPORTED;
  }

  const result: Record<string, unknown> = {};
  for (
    const [key, item] of entries.slice(
      0,
      AUDIT_REDACTION_LIMITS.maxCollectionEntries,
    )
  ) {
    const sensitiveField = SENSITIVE_KEY_PATTERN.test(key);
    const credentialShapedKey = containsSensitiveValue(key);
    const boundedKey = mode === "redact" && credentialShapedKey
      ? REDACTED
      : key.slice(0, 256);
    result[boundedKey] = mode === "redact" &&
        (sensitiveField || credentialShapedKey)
      ? REDACTED
      : normalizeAuditValue(item, depth + 1, state, mode);
  }
  if (entries.length > AUDIT_REDACTION_LIMITS.maxCollectionEntries) {
    result.__truncated__ = TRUNCATED;
  }
  return result;
}

function redactString(value: string, state: NormalizationState): string {
  const remaining = Math.max(
    0,
    AUDIT_REDACTION_LIMITS.maxTotalStringCharacters - state.stringCharacters,
  );
  if (remaining === 0) return TRUNCATED;

  const candidate = value.slice(
    0,
    Math.min(remaining, AUDIT_REDACTION_LIMITS.maxStringCharacters),
  );
  if (containsSensitiveValue(candidate)) return REDACTED;
  return boundedString(value, state);
}

function boundedString(value: string, state: NormalizationState): string {
  const remaining = Math.max(
    0,
    AUDIT_REDACTION_LIMITS.maxTotalStringCharacters - state.stringCharacters,
  );
  if (remaining === 0) return TRUNCATED;

  const allowed = Math.min(
    remaining,
    AUDIT_REDACTION_LIMITS.maxStringCharacters,
  );
  const truncated = value.length > allowed;
  const result = truncated
    ? `${value.slice(0, Math.max(0, allowed - TRUNCATED.length))}${TRUNCATED}`
    : value;
  state.stringCharacters += result.length;
  return result;
}

function containsSensitiveValue(value: string): boolean {
  if (
    AUTHORIZATION_VALUE_PATTERN.test(value) ||
    JWT_PATTERN.test(value) ||
    TOKEN_PREFIX_PATTERN.test(value) ||
    PRIVATE_KEY_PATTERN.test(value) ||
    SENSITIVE_ASSIGNMENT_PATTERN.test(value)
  ) {
    return true;
  }

  for (const match of value.matchAll(URL_PATTERN)) {
    try {
      const url = new URL(match[0]);
      if (url.username !== "" || url.password !== "") return true;
      for (const key of url.searchParams.keys()) {
        if (
          SENSITIVE_KEY_PATTERN.test(key) ||
          SENSITIVE_QUERY_PARAMETER_PATTERN.test(key)
        ) {
          return true;
        }
      }
    } catch {
      // A malformed URL is handled by the other value patterns or truncation.
    }
  }
  return false;
}

interface NormalizedAuditEvent {
  readonly actorType: AuditActorType;
  readonly actorUserId: string | null;
  readonly oauthClientId: string | null;
  readonly workspaceId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly outcome: AuditOutcome;
  readonly reasonCode: string | null;
  readonly beforeSnapshot: unknown;
  readonly afterSnapshot: unknown;
  readonly requestId: string | null;
  readonly traceId: string | null;
  readonly ipHashOrPolicyValue: string | null;
  readonly userAgentSummary: string | null;
}

function normalizeEvent(event: AuditEventInput): NormalizedAuditEvent {
  return {
    actorType: event.actorType,
    actorUserId: boundedIdentifier(event.actorUserId, "actorUserId"),
    oauthClientId: boundedIdentifier(event.oauthClientId, "oauthClientId"),
    workspaceId: boundedIdentifier(event.workspaceId, "workspaceId"),
    action: requiredIdentifier(event.action, "action"),
    targetType: requiredIdentifier(event.targetType, "targetType"),
    targetId: redactedOptionalText(event.targetId),
    outcome: event.outcome,
    reasonCode: redactedOptionalText(event.reasonCode),
    beforeSnapshot: event.beforeSnapshot === undefined
      ? null
      : redactAuditValue(event.beforeSnapshot),
    afterSnapshot: event.afterSnapshot === undefined
      ? null
      : redactAuditValue(event.afterSnapshot),
    requestId: strictOptionalIdentifier(event.requestId, "requestId"),
    traceId: strictOptionalIdentifier(event.traceId, "traceId"),
    ipHashOrPolicyValue: redactedOptionalText(event.ipHashOrPolicyValue),
    userAgentSummary: redactedOptionalText(event.userAgentSummary),
  };
}

function requiredIdentifier(value: string, field: string): string {
  const result = boundedIdentifier(value, field);
  if (result === null || result.trim() === "") {
    throw new TypeError(`${field} must not be empty`);
  }
  return result;
}

function boundedIdentifier(
  value: string | null | undefined,
  field: string,
  maxLength = 256,
): string | null {
  if (value === null || value === undefined) return null;
  if (value.length > maxLength) {
    throw new TypeError(`${field} must be at most ${maxLength} characters`);
  }
  return value;
}

function strictOptionalIdentifier(
  value: string | null | undefined,
  field: string,
): string | null {
  const bounded = boundedIdentifier(value, field);
  if (bounded === null) return null;
  if (!CORRELATION_ID_PATTERN.test(bounded)) {
    throw new TypeError(
      `${field} must contain only letters, digits, dot, underscore, colon, or hyphen`,
    );
  }
  return bounded;
}

function strictIdempotencyKey(value: string): string {
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new TypeError(
      "idempotencyKey must be 16-128 URL-safe characters",
    );
  }
  return value;
}

function redactedOptionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return redactString(value, newNormalizationState());
}

function fingerprintOptionalText(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  return boundedString(value, newNormalizationState());
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${
    entries.map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalJson(item)}`
    ).join(",")
  }}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

interface AuditIdempotencyArtifacts {
  readonly scopeHash: string;
  readonly keyHash: string;
  readonly eventFingerprint: string;
}

async function createIdempotencyArtifacts(
  event: AuditEventInput,
  normalized: NormalizedAuditEvent,
): Promise<AuditIdempotencyArtifacts | null> {
  if (event.idempotencyKey === null || event.idempotencyKey === undefined) {
    return null;
  }
  const rawKey = strictIdempotencyKey(event.idempotencyKey);
  const scopeHash = await sha256Hex(canonicalJson({
    actorType: normalized.actorType,
    actorUserId: normalized.actorUserId,
    oauthClientId: normalized.oauthClientId,
    workspaceId: normalized.workspaceId,
    action: normalized.action,
    targetType: normalized.targetType,
  }));
  const keyHash = await sha256Hex(
    `relay-audit-key:v2\0${scopeHash}\0${rawKey}`,
  );
  const fingerprint = await sha256Hex(canonicalJson({
    actorType: normalized.actorType,
    actorUserId: normalized.actorUserId,
    oauthClientId: normalized.oauthClientId,
    workspaceId: normalized.workspaceId,
    action: normalized.action,
    targetType: normalized.targetType,
    targetId: fingerprintOptionalText(event.targetId),
    outcome: normalized.outcome,
    reasonCode: fingerprintOptionalText(event.reasonCode),
    beforeSnapshot: event.beforeSnapshot === undefined
      ? null
      : fingerprintAuditValue(event.beforeSnapshot),
    afterSnapshot: event.afterSnapshot === undefined
      ? null
      : fingerprintAuditValue(event.afterSnapshot),
    requestId: normalized.requestId,
    traceId: normalized.traceId,
    ipHashOrPolicyValue: fingerprintOptionalText(event.ipHashOrPolicyValue),
    userAgentSummary: fingerprintOptionalText(event.userAgentSummary),
  }));
  return {
    scopeHash,
    keyHash,
    eventFingerprint: fingerprint,
  };
}

/**
 * Inserts one immutable event through the database-owned audit function.
 * Idempotency keys are validated, hashed, and scoped to actor/workspace/action;
 * replay comparison uses a bounded pre-redaction semantic fingerprint so two
 * different credential changes cannot collapse to the same redacted event.
 */
export async function recordAuditEvent(
  queryable: Queryable,
  event: AuditEventInput,
): Promise<void> {
  const normalized = normalizeEvent(event);
  const idempotency = await createIdempotencyArtifacts(event, normalized);
  const result = await queryable.query<{ disposition: string }>(
    `select relay.record_audit_event(
       $1::text, $2::text, $3::text, $4::text, $5::text, $6::text,
       $7::text, $8::text, $9::text, $10::jsonb, $11::jsonb, $12::text,
       $13::text, $14::text, $15::text, $16::text, $17::text, $18::text
     ) as disposition`,
    [
      normalized.actorType,
      normalized.actorUserId,
      normalized.oauthClientId,
      normalized.workspaceId,
      normalized.action,
      normalized.targetType,
      normalized.targetId,
      normalized.outcome,
      normalized.reasonCode,
      normalized.beforeSnapshot === null
        ? null
        : JSON.stringify(normalized.beforeSnapshot),
      normalized.afterSnapshot === null
        ? null
        : JSON.stringify(normalized.afterSnapshot),
      normalized.requestId,
      normalized.traceId,
      normalized.ipHashOrPolicyValue,
      normalized.userAgentSummary,
      idempotency?.scopeHash ?? null,
      idempotency?.keyHash ?? null,
      idempotency?.eventFingerprint ?? null,
    ],
  );

  const disposition = result.rows[0]?.disposition;
  if (disposition === "inserted" || disposition === "replayed") return;
  if (disposition === "conflict") throw new AuditIdempotencyConflictError();
  throw new Error("Audit function returned an unexpected result");
}
