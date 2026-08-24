import type { ArtifactQueryable } from "./database.ts";

export interface ArtifactQuotaReservationRequest {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly bytes: number;
}

export type ArtifactQuotaReservationResult =
  | { readonly kind: "reserved"; readonly reservationId: string }
  | { readonly kind: "denied" };

/**
 * Implementations must use the supplied queryable so quota state and artifact
 * staging commit or roll back together. commit/release/decrementCommitted must
 * be idempotent. A committed decrement is a durable purge settlement, not a
 * release of a pending reservation.
 */
export interface ArtifactQuota {
  reserve(
    queryable: ArtifactQueryable,
    request: ArtifactQuotaReservationRequest,
  ): Promise<ArtifactQuotaReservationResult>;
  commit(
    queryable: ArtifactQueryable,
    request: {
      readonly workspaceId: string;
      readonly reservationId: string;
      readonly bytes: number;
    },
  ): Promise<void>;
  release(
    queryable: ArtifactQueryable,
    request: {
      readonly workspaceId: string;
      readonly reservationId: string;
      readonly bytes: number;
    },
  ): Promise<void>;
  decrementCommitted(
    queryable: ArtifactQueryable,
    request: {
      readonly workspaceId: string;
      readonly reservationId: string;
      /** Stable per-version purge operation ID for adapter-side deduplication. */
      readonly operationId: string;
      readonly bytes: number;
    },
  ): Promise<void>;
}
