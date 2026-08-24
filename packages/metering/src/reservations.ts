import { fingerprint, generateMeteringId, sha256Hex } from "./canonical.ts";
import { compareDecimalAmounts, normalizeDecimalAmount } from "./decimal.ts";
import { transactionTimestamp } from "./entitlements.ts";
import {
  InvalidPolicyError,
  settlementActionFor,
  type SettlementOutcome,
} from "./policies.ts";
import { lockIdempotencyKey } from "./postgres.ts";
import {
  assertMeteringTransaction,
  type MeteringTransaction,
} from "./transaction.ts";
import { requirePositiveSafeInteger, requireText } from "./validation.ts";

export interface CommitUsageReservationInput {
  readonly workspaceId: string;
  readonly reservationId: string;
  readonly idempotencyKey: string;
  readonly outcome: SettlementOutcome;
  readonly actualAmount: string;
}

export interface ReleaseUsageReservationInput {
  readonly workspaceId: string;
  readonly reservationId: string;
  readonly idempotencyKey: string;
  readonly outcome: Exclude<SettlementOutcome, "success">;
}

export interface ExpireUsageReservationInput {
  readonly workspaceId: string;
  readonly reservationId: string;
  readonly idempotencyKey: string;
}

export interface UsageFinalizationReceipt {
  readonly reservationId: string;
  readonly status: "committed" | "released" | "expired";
  readonly outcome: string;
  readonly committedAmount: string;
  readonly releasedAmount: string;
  readonly usageEventId: string | null;
  readonly finalizedAt: Date;
}

export type UsageFinalizationResult =
  | {
    readonly kind: "committed" | "released" | "expired" | "replayed";
    readonly receipt: UsageFinalizationReceipt;
  }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_due" }
  | { readonly kind: "idempotency_conflict" }
  | {
    readonly kind: "already_finalized";
    readonly status: "committed" | "released" | "expired";
  }
  | {
    readonly kind: "settlement_action_mismatch";
    readonly requiredAction: "commit_actual" | "release";
  }
  | {
    readonly kind: "actual_exceeds_reservation";
    readonly reservedAmount: string;
  }
  | { readonly kind: "invalid_configuration" };

interface ReservationFinalizationRow {
  id: string;
  workspace_id: string;
  bucket_id: string;
  status: "active" | "committed" | "released" | "expired";
  metric_key: string;
  unit: string;
  reserved_amount: string;
  committed_amount: string;
  released_amount: string;
  meter_policy_id: string;
  meter_policy_key: string;
  meter_policy_revision: number;
  meter_policy_hash: string;
  meter_policy_snapshot: unknown;
  entitlement_snapshot: unknown;
  finalization_operation: "commit" | "release" | "expire" | null;
  finalization_outcome: string | null;
  finalization_idempotency_key_hash: string | null;
  finalization_request_hash: string | null;
  expires_at: Date;
  finalized_at: Date | null;
}

function validateIdentity(input: {
  readonly workspaceId: string;
  readonly reservationId: string;
  readonly idempotencyKey: string;
}): void {
  requireText(input.workspaceId, "workspaceId");
  requireText(input.reservationId, "reservationId");
  requireText(input.idempotencyKey, "idempotencyKey");
}

async function lockReservation(
  transaction: MeteringTransaction,
  workspaceId: string,
  reservationId: string,
): Promise<ReservationFinalizationRow | null> {
  const { rows } = await transaction.query<ReservationFinalizationRow>(
    `select id, workspace_id, bucket_id::text, status, metric_key, unit,
            reserved_amount, committed_amount, released_amount,
            meter_policy_id, meter_policy_key, meter_policy_revision,
            meter_policy_hash, meter_policy_snapshot, entitlement_snapshot,
            finalization_operation, finalization_outcome,
            finalization_idempotency_key_hash, finalization_request_hash,
            expires_at, finalized_at
       from relay.usage_reservations
      where workspace_id = $1 and id = $2
      for update`,
    [workspaceId, reservationId],
  );
  return rows[0] ?? null;
}

async function keyBelongsToAnotherReservation(
  transaction: MeteringTransaction,
  workspaceId: string,
  reservationId: string,
  keyHash: string,
): Promise<boolean> {
  const { rows } = await transaction.query<{ id: string }>(
    `select id
       from relay.usage_reservations
      where workspace_id = $1
        and finalization_idempotency_key_hash = $2
        and id <> $3`,
    [workspaceId, keyHash, reservationId],
  );
  return rows.length > 0;
}

async function receiptFor(
  transaction: MeteringTransaction,
  reservation: ReservationFinalizationRow,
): Promise<UsageFinalizationReceipt> {
  if (reservation.status === "active" || reservation.finalized_at === null) {
    throw new Error(
      "Cannot build a finalization receipt for an active reservation",
    );
  }
  const event = await transaction.query<{ id: string }>(
    `select id from relay.usage_events where reservation_id = $1`,
    [reservation.id],
  );
  return {
    reservationId: reservation.id,
    status: reservation.status,
    outcome: reservation.finalization_outcome ?? "unknown",
    committedAmount: normalizeDecimalAmount(reservation.committed_amount),
    releasedAmount: normalizeDecimalAmount(reservation.released_amount),
    usageEventId: event.rows[0]?.id ?? null,
    finalizedAt: reservation.finalized_at,
  };
}

async function resolveTerminalReplay(
  transaction: MeteringTransaction,
  reservation: ReservationFinalizationRow,
  operation: "commit" | "release" | "expire",
  keyHash: string,
  requestHash: string,
): Promise<UsageFinalizationResult> {
  if (
    reservation.finalization_idempotency_key_hash === keyHash &&
    reservation.finalization_request_hash === requestHash &&
    (reservation.finalization_operation === operation ||
      reservation.status === "expired")
  ) {
    return {
      kind: "replayed",
      receipt: await receiptFor(transaction, reservation),
    };
  }
  if (reservation.finalization_idempotency_key_hash === keyHash) {
    return { kind: "idempotency_conflict" };
  }
  return {
    kind: "already_finalized",
    status: reservation.status as Exclude<
      ReservationFinalizationRow["status"],
      "active"
    >,
  };
}

async function releaseLockedReservation(
  transaction: MeteringTransaction,
  reservation: ReservationFinalizationRow,
  operation: "release" | "expire",
  outcome: string,
  keyHash: string,
  requestHash: string,
  finalizedAt: Date,
): Promise<UsageFinalizationReceipt> {
  const bucket = await transaction.query<{ id: string }>(
    `update relay.usage_buckets
        set reserved_amount = reserved_amount - $3::numeric,
            updated_at = $4
      where id = $1 and workspace_id = $2
        and reserved_amount >= $3::numeric
      returning id::text`,
    [
      reservation.bucket_id,
      reservation.workspace_id,
      reservation.reserved_amount,
      finalizedAt,
    ],
  );
  if (bucket.rows.length !== 1) {
    throw new Error("Usage bucket no longer contains the reservation amount");
  }

  const status = operation === "expire" ? "expired" : "released";
  const updated = await transaction.query<ReservationFinalizationRow>(
    `update relay.usage_reservations
        set status = $3,
            released_amount = reserved_amount,
            finalization_operation = $4,
            finalization_outcome = $5,
            finalization_idempotency_key_hash = $6,
            finalization_request_hash = $7,
            finalized_at = $8
      where workspace_id = $1 and id = $2 and status = 'active'
      returning id, workspace_id, bucket_id::text, status, metric_key, unit,
                reserved_amount, committed_amount, released_amount,
                meter_policy_id, meter_policy_key, meter_policy_revision,
                meter_policy_hash, meter_policy_snapshot, entitlement_snapshot,
                finalization_operation, finalization_outcome,
                finalization_idempotency_key_hash, finalization_request_hash,
                expires_at, finalized_at`,
    [
      reservation.workspace_id,
      reservation.id,
      status,
      operation,
      outcome,
      keyHash,
      requestHash,
      finalizedAt,
    ],
  );
  if (updated.rows.length !== 1) {
    throw new Error("Active usage reservation disappeared during release");
  }
  return await receiptFor(transaction, updated.rows[0]);
}

async function expireLockedIfDue(
  transaction: MeteringTransaction,
  reservation: ReservationFinalizationRow,
  at: Date,
  keyHash: string,
  requestHash: string,
): Promise<UsageFinalizationReceipt | null> {
  if (reservation.expires_at > at) return null;
  return await releaseLockedReservation(
    transaction,
    reservation,
    "expire",
    "reservation_ttl_elapsed",
    keyHash,
    requestHash,
    at,
  );
}

export async function commitUsageReservation(
  transaction: MeteringTransaction,
  input: CommitUsageReservationInput,
): Promise<UsageFinalizationResult> {
  assertMeteringTransaction(transaction);
  validateIdentity(input);
  const actualAmount = normalizeDecimalAmount(input.actualAmount);
  const keyHash = await sha256Hex(input.idempotencyKey);
  const requestHash = await fingerprint({
    operation: "commit",
    workspaceId: input.workspaceId,
    reservationId: input.reservationId,
    outcome: input.outcome,
    actualAmount,
  });
  await lockIdempotencyKey(
    transaction,
    input.workspaceId,
    "usage-finalize",
    keyHash,
  );
  if (
    await keyBelongsToAnotherReservation(
      transaction,
      input.workspaceId,
      input.reservationId,
      keyHash,
    )
  ) return { kind: "idempotency_conflict" };

  const reservation = await lockReservation(
    transaction,
    input.workspaceId,
    input.reservationId,
  );
  if (reservation === null) return { kind: "not_found" };
  if (reservation.status !== "active") {
    return await resolveTerminalReplay(
      transaction,
      reservation,
      "commit",
      keyHash,
      requestHash,
    );
  }

  const at = await transactionTimestamp(transaction);
  const expired = await expireLockedIfDue(
    transaction,
    reservation,
    at,
    keyHash,
    requestHash,
  );
  if (expired !== null) return { kind: "expired", receipt: expired };

  let requiredAction: "commit_actual" | "release";
  try {
    requiredAction = settlementActionFor(
      reservation.meter_policy_snapshot,
      input.outcome,
    );
  } catch (error) {
    if (error instanceof InvalidPolicyError) {
      return { kind: "invalid_configuration" };
    }
    throw error;
  }
  if (requiredAction !== "commit_actual") {
    return { kind: "settlement_action_mismatch", requiredAction };
  }
  if (compareDecimalAmounts(actualAmount, reservation.reserved_amount) > 0) {
    return {
      kind: "actual_exceeds_reservation",
      reservedAmount: normalizeDecimalAmount(reservation.reserved_amount),
    };
  }

  const bucket = await transaction.query<{ id: string }>(
    `update relay.usage_buckets
        set reserved_amount = reserved_amount - $3::numeric,
            consumed_amount = consumed_amount + $4::numeric,
            updated_at = $5
      where id = $1 and workspace_id = $2
        and reserved_amount >= $3::numeric
      returning id::text`,
    [
      reservation.bucket_id,
      input.workspaceId,
      reservation.reserved_amount,
      actualAmount,
      at,
    ],
  );
  if (bucket.rows.length !== 1) {
    throw new Error("Usage bucket no longer contains the reservation amount");
  }

  const usageEventId = generateMeteringId("usage");
  await transaction.query(
    `insert into relay.usage_events (
       id, workspace_id, reservation_id, bucket_id, metric_key, unit,
       quantity, outcome, meter_policy_id, meter_policy_key,
       meter_policy_revision, meter_policy_hash, meter_policy_snapshot,
       entitlement_snapshot, idempotency_key_hash, request_hash, occurred_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17
     )`,
    [
      usageEventId,
      input.workspaceId,
      reservation.id,
      reservation.bucket_id,
      reservation.metric_key,
      reservation.unit,
      actualAmount,
      input.outcome,
      reservation.meter_policy_id,
      reservation.meter_policy_key,
      reservation.meter_policy_revision,
      reservation.meter_policy_hash,
      JSON.stringify(reservation.meter_policy_snapshot),
      JSON.stringify(reservation.entitlement_snapshot),
      keyHash,
      requestHash,
      at,
    ],
  );

  const updated = await transaction.query<ReservationFinalizationRow>(
    `update relay.usage_reservations
        set status = 'committed',
            committed_amount = $3,
            released_amount = reserved_amount - $3::numeric,
            finalization_operation = 'commit',
            finalization_outcome = $4,
            finalization_idempotency_key_hash = $5,
            finalization_request_hash = $6,
            finalized_at = $7
      where workspace_id = $1 and id = $2 and status = 'active'
      returning id, workspace_id, bucket_id::text, status, metric_key, unit,
                reserved_amount, committed_amount, released_amount,
                meter_policy_id, meter_policy_key, meter_policy_revision,
                meter_policy_hash, meter_policy_snapshot, entitlement_snapshot,
                finalization_operation, finalization_outcome,
                finalization_idempotency_key_hash, finalization_request_hash,
                expires_at, finalized_at`,
    [
      input.workspaceId,
      reservation.id,
      actualAmount,
      input.outcome,
      keyHash,
      requestHash,
      at,
    ],
  );
  if (updated.rows.length !== 1) {
    throw new Error("Active usage reservation disappeared during commit");
  }
  const receipt = await receiptFor(transaction, updated.rows[0]);
  if (receipt.usageEventId !== usageEventId) {
    throw new Error("Committed usage event could not be reloaded");
  }
  return { kind: "committed", receipt };
}

export async function releaseUsageReservation(
  transaction: MeteringTransaction,
  input: ReleaseUsageReservationInput,
): Promise<UsageFinalizationResult> {
  assertMeteringTransaction(transaction);
  validateIdentity(input);
  const keyHash = await sha256Hex(input.idempotencyKey);
  const requestHash = await fingerprint({
    operation: "release",
    workspaceId: input.workspaceId,
    reservationId: input.reservationId,
    outcome: input.outcome,
  });
  await lockIdempotencyKey(
    transaction,
    input.workspaceId,
    "usage-finalize",
    keyHash,
  );
  if (
    await keyBelongsToAnotherReservation(
      transaction,
      input.workspaceId,
      input.reservationId,
      keyHash,
    )
  ) return { kind: "idempotency_conflict" };

  const reservation = await lockReservation(
    transaction,
    input.workspaceId,
    input.reservationId,
  );
  if (reservation === null) return { kind: "not_found" };
  if (reservation.status !== "active") {
    return await resolveTerminalReplay(
      transaction,
      reservation,
      "release",
      keyHash,
      requestHash,
    );
  }

  const at = await transactionTimestamp(transaction);
  const expired = await expireLockedIfDue(
    transaction,
    reservation,
    at,
    keyHash,
    requestHash,
  );
  if (expired !== null) return { kind: "expired", receipt: expired };

  let requiredAction: "commit_actual" | "release";
  try {
    requiredAction = settlementActionFor(
      reservation.meter_policy_snapshot,
      input.outcome,
    );
  } catch (error) {
    if (error instanceof InvalidPolicyError) {
      return { kind: "invalid_configuration" };
    }
    throw error;
  }
  if (requiredAction !== "release") {
    return { kind: "settlement_action_mismatch", requiredAction };
  }

  return {
    kind: "released",
    receipt: await releaseLockedReservation(
      transaction,
      reservation,
      "release",
      input.outcome,
      keyHash,
      requestHash,
      at,
    ),
  };
}

export async function expireUsageReservation(
  transaction: MeteringTransaction,
  input: ExpireUsageReservationInput,
): Promise<UsageFinalizationResult> {
  assertMeteringTransaction(transaction);
  validateIdentity(input);
  const keyHash = await sha256Hex(input.idempotencyKey);
  const requestHash = await fingerprint({
    operation: "expire",
    workspaceId: input.workspaceId,
    reservationId: input.reservationId,
    reason: "reservation_ttl_elapsed",
  });
  await lockIdempotencyKey(
    transaction,
    input.workspaceId,
    "usage-finalize",
    keyHash,
  );
  if (
    await keyBelongsToAnotherReservation(
      transaction,
      input.workspaceId,
      input.reservationId,
      keyHash,
    )
  ) return { kind: "idempotency_conflict" };

  const reservation = await lockReservation(
    transaction,
    input.workspaceId,
    input.reservationId,
  );
  if (reservation === null) return { kind: "not_found" };
  if (reservation.status !== "active") {
    return await resolveTerminalReplay(
      transaction,
      reservation,
      "expire",
      keyHash,
      requestHash,
    );
  }
  const at = await transactionTimestamp(transaction);
  if (reservation.expires_at > at) return { kind: "not_due" };
  return {
    kind: "expired",
    receipt: await releaseLockedReservation(
      transaction,
      reservation,
      "expire",
      "reservation_ttl_elapsed",
      keyHash,
      requestHash,
      at,
    ),
  };
}

export interface ExpireUsageReservationsResult {
  readonly expired: number;
  readonly reservationIds: readonly string[];
}

/**
 * Concurrent sweepers divide work with `FOR UPDATE SKIP LOCKED`, then lock all
 * affected buckets in numeric ID order before applying any release. The fixed
 * bucket order prevents two batches with interleaved buckets from deadlocking.
 * Derived per-reservation keys make reruns idempotent even after a crash.
 */
export async function expireUsageReservations(
  transaction: MeteringTransaction,
  batchSize: number = 100,
): Promise<ExpireUsageReservationsResult> {
  assertMeteringTransaction(transaction);
  requirePositiveSafeInteger(batchSize, "batchSize", 1_000);
  const at = await transactionTimestamp(transaction);
  const due = await transaction.query<ReservationFinalizationRow>(
    `select id, workspace_id, bucket_id::text, status, metric_key, unit,
            reserved_amount, committed_amount, released_amount,
            meter_policy_id, meter_policy_key, meter_policy_revision,
            meter_policy_hash, meter_policy_snapshot, entitlement_snapshot,
            finalization_operation, finalization_outcome,
            finalization_idempotency_key_hash, finalization_request_hash,
            expires_at, finalized_at
       from relay.usage_reservations
      where status = 'active' and expires_at <= $1
      order by expires_at, id
      limit $2
      for update skip locked`,
    [at, batchSize],
  );
  if (due.rows.length > 0) {
    await transaction.query<{ id: string }>(
      `select id::text
         from relay.usage_buckets
        where id = any($1::bigint[])
        order by id
        for update`,
      [[...new Set(due.rows.map((reservation) => reservation.bucket_id))]],
    );
  }

  const reservationIds: string[] = [];
  for (const reservation of due.rows) {
    const keyHash = await sha256Hex(
      `usage-reservation-expire:${reservation.id}`,
    );
    const requestHash = await fingerprint({
      operation: "expire",
      workspaceId: reservation.workspace_id,
      reservationId: reservation.id,
      reason: "reservation_ttl_elapsed",
    });
    await releaseLockedReservation(
      transaction,
      reservation,
      "expire",
      "reservation_ttl_elapsed",
      keyHash,
      requestHash,
      at,
    );
    reservationIds.push(reservation.id);
  }
  return { expired: reservationIds.length, reservationIds };
}
