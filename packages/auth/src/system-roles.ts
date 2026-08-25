export interface Queryable {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface SystemRoleGrant {
  readonly id: string;
  readonly userId: string;
  readonly grantedBy: string;
  readonly grantedAt: string;
}

export interface SuperadminOperator {
  /** Better Auth session row ID; the database derives and locks its user. */
  readonly sessionId: string;
}

export interface SuperadminMutationRequest {
  readonly targetUserId: string;
  readonly operator: SuperadminOperator;
  readonly idempotencyKey: string;
}

export interface BootstrapSuperadminRequest {
  readonly targetUserId: string;
  readonly idempotencyKey: string;
}

export type SuperadminMutationResult =
  | { readonly kind: "changed" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "replayed" }
  | {
    readonly kind: "denied";
    readonly reason: "operator_not_superadmin" | "last_superadmin";
  }
  | { readonly kind: "reauthentication_required" };

export type BootstrapSuperadminResult =
  | { readonly kind: "changed" }
  | { readonly kind: "replayed" };

export class SystemRoleIdempotencyConflictError extends Error {
  override readonly name = "SystemRoleIdempotencyConflictError";

  constructor() {
    super("System-role idempotency key was reused for a different mutation");
  }
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

/**
 * Queries a current unrevoked grant on every call -- revocation must take
 * effect immediately, not after a session/cache window expires.
 */
export async function isSuperadmin(
  queryable: Queryable,
  userId: string,
): Promise<boolean> {
  const result = await queryable.query(
    `select 1 from relay.system_role_assignments
     where user_id = $1 and revoked_at is null
     limit 1`,
    [userId],
  );
  return result.rows.length > 0;
}

/**
 * One-time bootstrap for an empty installation. The database function is not
 * executable by `relay_app`; callers must use a deliberately privileged
 * migrator/owner connection. The bootstrap marker and audit event are atomic.
 */
export async function bootstrapSuperadmin(
  queryable: Queryable,
  request: BootstrapSuperadminRequest,
): Promise<BootstrapSuperadminResult> {
  assertUserId(request.targetUserId, "targetUserId");
  const idempotencyKeyHash = await hashIdempotencyKey(request.idempotencyKey);
  const result = await queryable.query<{ result: string }>(
    "select relay.bootstrap_superadmin($1, $2) as result",
    [request.targetUserId, idempotencyKeyHash],
  );
  const status = result.rows[0]?.result;
  if (status === "changed" || status === "replayed") {
    return { kind: status };
  }
  throw new Error("Unexpected bootstrap_superadmin result");
}

/**
 * Grants through the database-owned function. The caller provides only a
 * Better Auth session ID; the database derives the operator, verifies expiry
 * and freshness, locks the current grant, mutates, and audits atomically.
 */
export async function grantSuperadmin(
  queryable: Queryable,
  request: SuperadminMutationRequest,
): Promise<SuperadminMutationResult> {
  return await mutateSuperadmin(queryable, "grant", request);
}

/** See `grantSuperadmin`; revoke uses the same locked authorization boundary. */
export async function revokeSuperadmin(
  queryable: Queryable,
  request: SuperadminMutationRequest,
): Promise<SuperadminMutationResult> {
  return await mutateSuperadmin(queryable, "revoke", request);
}

async function mutateSuperadmin(
  queryable: Queryable,
  operation: "grant" | "revoke",
  request: SuperadminMutationRequest,
): Promise<SuperadminMutationResult> {
  assertUserId(request.targetUserId, "targetUserId");
  assertUserId(request.operator.sessionId, "operator.sessionId");
  const idempotencyKeyHash = await hashIdempotencyKey(request.idempotencyKey);

  try {
    const result = await queryable.query<{ result: string }>(
      `select relay.${operation}_superadmin($1, $2, $3) as result`,
      [
        request.targetUserId,
        request.operator.sessionId,
        idempotencyKeyHash,
      ],
    );
    const status = result.rows[0]?.result;
    if (
      status === "changed" || status === "unchanged" || status === "replayed"
    ) {
      return { kind: status };
    }
    if (status === "last_superadmin") {
      return { kind: "denied", reason: "last_superadmin" };
    }
    throw new Error(`Unexpected ${operation}_superadmin result`);
  } catch (error) {
    const code = databaseErrorCode(error);
    if (code === "42501") {
      return { kind: "denied", reason: "operator_not_superadmin" };
    }
    if (code === "28000" || code === "55000") {
      return { kind: "reauthentication_required" };
    }
    if (code === "22023") throw new SystemRoleIdempotencyConflictError();
    throw error;
  }
}

function assertUserId(value: string, field: string): void {
  if (value.trim() === "" || value.length > 256) {
    throw new TypeError(`${field} must be 1-256 characters`);
  }
}

async function hashIdempotencyKey(value: string): Promise<string> {
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new TypeError(
      "Superadmin idempotency keys must be 16-128 URL-safe characters",
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`relay-system-role-idempotency:v1\0${value}`),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
