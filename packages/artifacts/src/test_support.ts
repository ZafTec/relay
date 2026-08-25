import type { ArtifactQuota } from "./quota.ts";

/** Test/integration helper; production metering should provide a durable adapter. */
export function createInMemoryQuota(): ArtifactQuota & {
  readonly reserved: Map<
    string,
    "reserved" | "committed" | "decremented" | "released"
  >;
} {
  const reserved = new Map<
    string,
    "reserved" | "committed" | "decremented" | "released"
  >();
  return {
    reserved,
    reserve: (_queryable, request) => {
      const reservationId = `quota_${request.operationId}`;
      reserved.set(reservationId, "reserved");
      return Promise.resolve({ kind: "reserved", reservationId });
    },
    commit: (_queryable, request) => {
      reserved.set(request.reservationId, "committed");
      return Promise.resolve();
    },
    release: (_queryable, request) => {
      reserved.set(request.reservationId, "released");
      return Promise.resolve();
    },
    decrementCommitted: (_queryable, request) => {
      reserved.set(request.reservationId, "decremented");
      return Promise.resolve();
    },
  };
}
