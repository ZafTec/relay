import type { ArtifactQueryable } from "./database.ts";
import type {
  ArtifactQuota,
  ArtifactQuotaReservationRequest,
  ArtifactQuotaReservationResult,
} from "./quota.ts";

const POSTGRES_BIGINT_MAX = "9223372036854775807";
const IDENTIFIER_MAX_LENGTH = 255;
const LOCK_DOMAIN = "relay.artifact-storage-quota:v1";

export type ArtifactStorageLimitDecision =
  | { readonly kind: "limited"; readonly maxBytes: string }
  | { readonly kind: "unlimited" }
  | {
    readonly kind: "denied";
    readonly reason: "not_configured" | "unavailable";
  };

/**
 * Only an explicit, valid `limited` or `unlimited` decision can admit bytes.
 * Missing, unavailable, malformed, or throwing providers never become
 * accidental unlimited storage.
 */
export interface ArtifactStorageLimitProvider {
  getLimit(
    queryable: ArtifactQueryable,
    input: { readonly workspaceId: string },
  ): Promise<ArtifactStorageLimitDecision>;
}

export interface PostgresArtifactQuotaOptions {
  readonly limitProvider: ArtifactStorageLimitProvider;
  readonly generateReservationId?: () => string;
}

interface ReservationRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly operation_id: string;
  readonly reserved_bytes: string;
  readonly status: "reserved" | "committed" | "released" | "decremented";
}

export class ArtifactQuotaConflictError extends Error {
  override readonly name = "ArtifactQuotaConflictError";
}

export class ArtifactQuotaInvariantError extends Error {
  override readonly name = "ArtifactQuotaInvariantError";
}

export class ArtifactQuotaLimitError extends Error {
  override readonly name = "ArtifactQuotaLimitError";
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function requireIdentifier(value: string, field: string): string {
  if (
    typeof value !== "string" || value.length < 1 ||
    value.length > IDENTIFIER_MAX_LENGTH || value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    throw new TypeError(`${field} has an invalid format`);
  }
  return value;
}

/** Normalizes a non-negative signed-PostgreSQL-bigint byte count as text. */
export function artifactStorageByteString(
  value: string | number | bigint,
  field = "bytes",
): string {
  let normalized: string;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${field} must be a non-negative safe integer`);
    }
    normalized = String(value);
  } else if (typeof value === "bigint") {
    if (value < 0n) {
      throw new TypeError(`${field} must be a non-negative PostgreSQL bigint`);
    }
    normalized = value.toString();
  } else if (typeof value === "string") {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
      throw new TypeError(
        `${field} must be a canonical non-negative integer string`,
      );
    }
    normalized = value;
  } else {
    throw new TypeError(`${field} must be a byte-count string`);
  }

  if (
    normalized.length > POSTGRES_BIGINT_MAX.length ||
    (normalized.length === POSTGRES_BIGINT_MAX.length &&
      normalized > POSTGRES_BIGINT_MAX)
  ) {
    throw new TypeError(`${field} exceeds the PostgreSQL bigint range`);
  }
  return normalized;
}

function defaultReservationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const suffix = Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `aqr_${suffix}`;
}

async function lockMutation(
  queryable: ArtifactQueryable,
  workspaceId: string,
  scope: string,
): Promise<void> {
  await queryable.query(
    `select pg_catalog.pg_advisory_xact_lock(
       pg_catalog.hashtextextended($1::text, 0)
     )`,
    [`${LOCK_DOMAIN}:${workspaceId}:${scope}`],
  );
}

async function findReservationByOperation(
  queryable: ArtifactQueryable,
  workspaceId: string,
  operationId: string,
): Promise<ReservationRow | null> {
  const result = await queryable.query<ReservationRow>(
    `select id, workspace_id, operation_id, reserved_bytes::text, status
       from relay.artifact_storage_reservations
      where workspace_id = $1 and operation_id = $2
      for update`,
    [workspaceId, operationId],
  );
  return result.rows[0] ?? null;
}

async function findReservationById(
  queryable: ArtifactQueryable,
  workspaceId: string,
  reservationId: string,
): Promise<ReservationRow | null> {
  const result = await queryable.query<ReservationRow>(
    `select id, workspace_id, operation_id, reserved_bytes::text, status
       from relay.artifact_storage_reservations
      where workspace_id = $1 and id = $2
      for update`,
    [workspaceId, reservationId],
  );
  return result.rows[0] ?? null;
}

function assertSameBytes(row: ReservationRow, bytes: string): void {
  if (
    artifactStorageByteString(
      row.reserved_bytes,
      "stored reservation bytes",
    ) !==
      bytes
  ) {
    throw new ArtifactQuotaConflictError(
      "Quota reservation was reused with a different byte count",
    );
  }
}

function validateLimitDecision(
  decision: ArtifactStorageLimitDecision,
): string | "denied" {
  if (decision?.kind === "unlimited") return POSTGRES_BIGINT_MAX;
  if (decision?.kind === "denied") {
    if (
      decision.reason !== "not_configured" && decision.reason !== "unavailable"
    ) {
      throw new ArtifactQuotaLimitError(
        "Artifact storage limit provider returned an invalid denial",
      );
    }
    return "denied";
  }
  if (decision?.kind === "limited") {
    try {
      return artifactStorageByteString(decision.maxBytes, "maxBytes");
    } catch (error) {
      throw new ArtifactQuotaLimitError(
        "Artifact storage limit provider returned an invalid limit",
        { cause: error },
      );
    }
  }
  throw new ArtifactQuotaLimitError(
    "Artifact storage limit provider returned an invalid decision",
  );
}

/**
 * Durable `ArtifactQuota` backed by `relay.artifact_storage_accounts` and
 * `relay.artifact_storage_reservations`.
 *
 * The supplied queryable must be the caller's open transaction, as required by
 * `ArtifactQuota`; row and advisory locks serialize quota changes across API and
 * worker processes and roll back with the artifact mutation.
 */
export class PostgresArtifactQuota implements ArtifactQuota {
  readonly #limitProvider: ArtifactStorageLimitProvider;
  readonly #generateReservationId: () => string;

  constructor(options: PostgresArtifactQuotaOptions) {
    if (
      options?.limitProvider === undefined ||
      typeof options.limitProvider.getLimit !== "function"
    ) {
      throw new TypeError("an artifact storage limit provider is required");
    }
    if (
      options.generateReservationId !== undefined &&
      typeof options.generateReservationId !== "function"
    ) {
      throw new TypeError("generateReservationId must be a function");
    }
    this.#limitProvider = options.limitProvider;
    this.#generateReservationId = options.generateReservationId ??
      defaultReservationId;
  }

  async reserve(
    queryable: ArtifactQueryable,
    request: ArtifactQuotaReservationRequest,
  ): Promise<ArtifactQuotaReservationResult> {
    const workspaceId = requireIdentifier(request.workspaceId, "workspaceId");
    const operationId = requireIdentifier(request.operationId, "operationId");
    const bytes = artifactStorageByteString(request.bytes);
    await lockMutation(queryable, workspaceId, `reserve:${operationId}`);

    const existing = await findReservationByOperation(
      queryable,
      workspaceId,
      operationId,
    );
    if (existing !== null) {
      assertSameBytes(existing, bytes);
      if (existing.status === "released" || existing.status === "decremented") {
        throw new ArtifactQuotaConflictError(
          "A terminal quota reservation cannot be reserved again",
        );
      }
      return { kind: "reserved", reservationId: existing.id };
    }

    let rawDecision: ArtifactStorageLimitDecision;
    try {
      rawDecision = await this.#limitProvider.getLimit(queryable, {
        workspaceId,
      });
    } catch (error) {
      throw new ArtifactQuotaLimitError(
        "Artifact storage limit could not be resolved",
        { cause: error },
      );
    }
    const limitBytes = validateLimitDecision(rawDecision);
    if (limitBytes === "denied") return { kind: "denied" };

    await queryable.query(
      `insert into relay.artifact_storage_accounts as account
         (workspace_id, limit_bytes, committed_bytes, reserved_bytes)
       values ($1, $2::bigint, 0, 0)
       on conflict (workspace_id) do update
         set limit_bytes = greatest(
               excluded.limit_bytes,
               account.committed_bytes + account.reserved_bytes
             ),
             updated_at = now()`,
      [workspaceId, limitBytes],
    );
    const reserved = await queryable.query<{ workspace_id: string }>(
      `update relay.artifact_storage_accounts
          set limit_bytes = $3::bigint,
              reserved_bytes = reserved_bytes + $2::bigint,
              updated_at = now()
        where workspace_id = $1
          and committed_bytes::numeric + reserved_bytes::numeric +
                $2::numeric <= $3::numeric
      returning workspace_id`,
      [workspaceId, bytes, limitBytes],
    );
    if (reserved.rows.length !== 1) return { kind: "denied" };

    const reservationId = requireIdentifier(
      this.#generateReservationId(),
      "generated reservationId",
    );
    const inserted = await queryable.query<{ id: string }>(
      `insert into relay.artifact_storage_reservations
         (id, workspace_id, operation_id, reserved_bytes, status)
       values ($1, $2, $3, $4::bigint, 'reserved')
       returning id`,
      [reservationId, workspaceId, operationId, bytes],
    );
    if (inserted.rows.length !== 1) {
      throw new ArtifactQuotaInvariantError(
        "Quota reservation insert did not return a row",
      );
    }
    return { kind: "reserved", reservationId: inserted.rows[0].id };
  }

  async commit(
    queryable: ArtifactQueryable,
    request: {
      readonly workspaceId: string;
      readonly reservationId: string;
      readonly bytes: number;
    },
  ): Promise<void> {
    const workspaceId = requireIdentifier(request.workspaceId, "workspaceId");
    const reservationId = requireIdentifier(
      request.reservationId,
      "reservationId",
    );
    const bytes = artifactStorageByteString(request.bytes);
    await lockMutation(queryable, workspaceId, `reservation:${reservationId}`);
    const reservation = await findReservationById(
      queryable,
      workspaceId,
      reservationId,
    );
    if (reservation === null) {
      throw new ArtifactQuotaInvariantError("Quota reservation was not found");
    }
    assertSameBytes(reservation, bytes);
    if (
      reservation.status === "committed" ||
      reservation.status === "decremented"
    ) return;
    if (reservation.status !== "reserved") {
      throw new ArtifactQuotaConflictError(
        "Released quota reservation cannot be committed",
      );
    }

    const account = await queryable.query<{ workspace_id: string }>(
      `update relay.artifact_storage_accounts
          set reserved_bytes = reserved_bytes - $2::bigint,
              committed_bytes = committed_bytes + $2::bigint,
              updated_at = now()
        where workspace_id = $1 and reserved_bytes >= $2::bigint
      returning workspace_id`,
      [workspaceId, bytes],
    );
    if (account.rows.length !== 1) {
      throw new ArtifactQuotaInvariantError(
        "Storage account no longer contains the reserved bytes",
      );
    }
    const updated = await queryable.query<{ id: string }>(
      `update relay.artifact_storage_reservations
          set status = 'committed', committed_at = now()
        where workspace_id = $1 and id = $2 and status = 'reserved'
      returning id`,
      [workspaceId, reservationId],
    );
    if (updated.rows.length !== 1) {
      throw new ArtifactQuotaInvariantError(
        "Reserved quota row disappeared during commit",
      );
    }
  }

  async release(
    queryable: ArtifactQueryable,
    request: {
      readonly workspaceId: string;
      readonly reservationId: string;
      readonly bytes: number;
    },
  ): Promise<void> {
    const workspaceId = requireIdentifier(request.workspaceId, "workspaceId");
    const reservationId = requireIdentifier(
      request.reservationId,
      "reservationId",
    );
    const bytes = artifactStorageByteString(request.bytes);
    await lockMutation(queryable, workspaceId, `reservation:${reservationId}`);
    const reservation = await findReservationById(
      queryable,
      workspaceId,
      reservationId,
    );
    if (reservation === null) {
      throw new ArtifactQuotaInvariantError("Quota reservation was not found");
    }
    assertSameBytes(reservation, bytes);
    if (reservation.status === "released") return;
    if (reservation.status !== "reserved") {
      throw new ArtifactQuotaConflictError(
        "Only reserved quota can be released",
      );
    }

    const account = await queryable.query<{ workspace_id: string }>(
      `update relay.artifact_storage_accounts
          set reserved_bytes = reserved_bytes - $2::bigint,
              updated_at = now()
        where workspace_id = $1 and reserved_bytes >= $2::bigint
      returning workspace_id`,
      [workspaceId, bytes],
    );
    if (account.rows.length !== 1) {
      throw new ArtifactQuotaInvariantError(
        "Storage account no longer contains the reserved bytes",
      );
    }
    const updated = await queryable.query<{ id: string }>(
      `update relay.artifact_storage_reservations
          set status = 'released', released_at = now()
        where workspace_id = $1 and id = $2 and status = 'reserved'
      returning id`,
      [workspaceId, reservationId],
    );
    if (updated.rows.length !== 1) {
      throw new ArtifactQuotaInvariantError(
        "Reserved quota row disappeared during release",
      );
    }
  }

  async decrementCommitted(
    queryable: ArtifactQueryable,
    request: {
      readonly workspaceId: string;
      readonly reservationId: string;
      readonly operationId: string;
      readonly bytes: number;
    },
  ): Promise<void> {
    const workspaceId = requireIdentifier(request.workspaceId, "workspaceId");
    const reservationId = requireIdentifier(
      request.reservationId,
      "reservationId",
    );
    const operationId = requireIdentifier(request.operationId, "operationId");
    const bytes = artifactStorageByteString(request.bytes);
    await lockMutation(queryable, workspaceId, `decrement:${operationId}`);
    await lockMutation(queryable, workspaceId, `reservation:${reservationId}`);

    const reservation = await findReservationById(
      queryable,
      workspaceId,
      reservationId,
    );
    if (reservation === null) {
      throw new ArtifactQuotaInvariantError("Quota reservation was not found");
    }
    assertSameBytes(reservation, bytes);
    if (reservation.status === "decremented") return;
    if (reservation.status !== "committed") {
      throw new ArtifactQuotaConflictError(
        "Only committed quota can be decremented",
      );
    }

    const account = await queryable.query<{ workspace_id: string }>(
      `update relay.artifact_storage_accounts
          set committed_bytes = committed_bytes - $2::bigint,
              updated_at = now()
        where workspace_id = $1 and committed_bytes >= $2::bigint
      returning workspace_id`,
      [workspaceId, bytes],
    );
    if (account.rows.length !== 1) {
      throw new ArtifactQuotaInvariantError(
        "Storage account no longer contains the committed bytes",
      );
    }
    const updated = await queryable.query<{ id: string }>(
      `update relay.artifact_storage_reservations
          set status = 'decremented', decremented_at = now()
        where workspace_id = $1 and id = $2 and status = 'committed'
      returning id`,
      [workspaceId, reservationId],
    );
    if (updated.rows.length !== 1) {
      throw new ArtifactQuotaInvariantError(
        "Committed quota row disappeared during decrement",
      );
    }
  }
}
