import { ApiError, fetchJson } from "./client";

export interface StorageUsageSummary {
  readonly generatedAt: string;
  readonly storedBytes: string;
  readonly reservedBytes: string;
  readonly cleanupPendingBytes: string;
  readonly limitBytes: string | null;
  readonly availableBytes: string | null;
}

export type StorageUsageResult =
  | { readonly kind: "ok"; readonly storage: StorageUsageSummary }
  | { readonly kind: "auth-expired" }
  | { readonly kind: "unavailable" };

export interface StorageUsageAdapter {
  getStorageSummary(signal?: AbortSignal): Promise<StorageUsageResult>;
}

const MAX_BYTES = 9223372036854775807n;

function record(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid storage summary");
  }
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).some((key) => !fields.includes(key)) ||
    fields.some((key) => !(key in object))
  ) {
    throw new TypeError("Invalid storage summary fields");
  }
  return object;
}

function bytes(value: unknown): string {
  if (
    typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/.test(value) ||
    BigInt(value) > MAX_BYTES
  ) {
    throw new TypeError("Invalid storage byte count");
  }
  return value;
}

export function parseStorageUsageResponse(value: unknown): StorageUsageSummary {
  const response = record(value, ["kind", "storage"]);
  if (response.kind !== "ok") {
    throw new TypeError("Storage summary unavailable");
  }
  const storage = record(response.storage, [
    "generatedAt",
    "storedBytes",
    "reservedBytes",
    "cleanupPendingBytes",
    "limitBytes",
    "availableBytes",
  ]);
  if (
    typeof storage.generatedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
      storage.generatedAt,
    ) ||
    !Number.isFinite(Date.parse(storage.generatedAt))
  ) throw new TypeError("Invalid storage timestamp");
  const storedBytes = bytes(storage.storedBytes);
  const reservedBytes = bytes(storage.reservedBytes);
  const cleanupPendingBytes = bytes(storage.cleanupPendingBytes);
  const limitBytes = storage.limitBytes === null
    ? null
    : bytes(storage.limitBytes);
  const availableBytes = storage.availableBytes === null
    ? null
    : bytes(storage.availableBytes);
  const occupied = BigInt(storedBytes) + BigInt(reservedBytes);
  const expectedAvailable = limitBytes === null
    ? null
    : (BigInt(limitBytes) > occupied ? BigInt(limitBytes) - occupied : 0n)
      .toString();
  if (
    occupied > MAX_BYTES ||
    BigInt(cleanupPendingBytes) > BigInt(reservedBytes) ||
    availableBytes !== expectedAvailable
  ) {
    throw new TypeError("Inconsistent storage summary");
  }
  return {
    generatedAt: storage.generatedAt,
    storedBytes,
    reservedBytes,
    cleanupPendingBytes,
    limitBytes,
    availableBytes,
  };
}

export const httpStorageUsageAdapter: StorageUsageAdapter = {
  async getStorageSummary(signal) {
    try {
      const storage = parseStorageUsageResponse(
        await fetchJson<unknown>("/api/v1/usage/storage", {
          cache: "no-store",
          signal,
        }),
      );
      return { kind: "ok", storage };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (error instanceof ApiError && error.status === 401) {
        return { kind: "auth-expired" };
      }
      return { kind: "unavailable" };
    }
  },
};
