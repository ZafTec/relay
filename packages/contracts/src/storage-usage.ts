import {
  type ContractSchema,
  defineContractSchema,
  enumValue,
  isoTimestamp,
  required,
  strictObject,
  stringValue,
  validationError,
} from "./schema.ts";

export interface StorageUsageSummary {
  readonly generatedAt: string;
  /** All committed versions, including files awaiting physical purge. */
  readonly storedBytes: string;
  /** Upload reservations, including failed uploads awaiting cleanup. */
  readonly reservedBytes: string;
  /** A subset of reservedBytes; not additional usage. */
  readonly cleanupPendingBytes: string;
  /** Null only when the enforcer explicitly grants unlimited storage. */
  readonly limitBytes: string | null;
  readonly availableBytes: string | null;
}

export type GetStorageUsageResult =
  | { readonly kind: "ok"; readonly storage: StorageUsageSummary }
  | { readonly kind: "not_found" }
  | { readonly kind: "unavailable" };

const BYTE_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/u;
const BIGINT_MAX = 9223372036854775807n;
const byteSchema = { type: "string", pattern: BYTE_PATTERN.source } as const;

export function storageByteCount(value: unknown, path: string): string {
  const parsed = stringValue(value, path, { pattern: BYTE_PATTERN });
  if (BigInt(parsed) > BIGINT_MAX) {
    validationError(path, "invalid_value", "exceeds the supported byte range");
  }
  return parsed;
}

export const storageUsageSummarySchema: ContractSchema<StorageUsageSummary> =
  defineContractSchema(
    "StorageUsageSummary",
    {
      type: "object",
      additionalProperties: false,
      required: [
        "generatedAt",
        "storedBytes",
        "reservedBytes",
        "cleanupPendingBytes",
        "limitBytes",
        "availableBytes",
      ],
      properties: {
        generatedAt: { type: "string", format: "date-time" },
        storedBytes: byteSchema,
        reservedBytes: byteSchema,
        cleanupPendingBytes: byteSchema,
        limitBytes: { anyOf: [byteSchema, { type: "null" }] },
        availableBytes: { anyOf: [byteSchema, { type: "null" }] },
      },
    },
    (value, path) => {
      const fields = [
        "generatedAt",
        "storedBytes",
        "reservedBytes",
        "cleanupPendingBytes",
        "limitBytes",
        "availableBytes",
      ];
      const object = strictObject(value, path, fields);
      const bytes = (field: string) =>
        storageByteCount(required(object, field, path), `${path}.${field}`);
      const nullableBytes = (field: string) =>
        required(object, field, path) === null ? null : bytes(field);
      const storedBytes = bytes("storedBytes");
      const reservedBytes = bytes("reservedBytes");
      const cleanupPendingBytes = bytes("cleanupPendingBytes");
      const limitBytes = nullableBytes("limitBytes");
      const availableBytes = nullableBytes("availableBytes");
      const occupied = BigInt(storedBytes) + BigInt(reservedBytes);
      if (occupied > BIGINT_MAX) {
        validationError(
          path,
          "invalid_value",
          "total bytes exceed the supported byte range",
        );
      }
      if (BigInt(cleanupPendingBytes) > BigInt(reservedBytes)) {
        validationError(
          path,
          "invalid_value",
          "cleanup bytes must be part of reserved bytes",
        );
      }
      const expectedAvailable = limitBytes === null
        ? null
        : (BigInt(limitBytes) > occupied ? BigInt(limitBytes) - occupied : 0n)
          .toString();
      if (availableBytes !== expectedAvailable) {
        validationError(
          path,
          "invalid_value",
          "available bytes must match the effective limit and usage",
        );
      }
      return {
        generatedAt: isoTimestamp(
          required(object, "generatedAt", path),
          `${path}.generatedAt`,
        ),
        storedBytes,
        reservedBytes,
        cleanupPendingBytes,
        limitBytes,
        availableBytes,
      };
    },
  );

export const getStorageUsageResultSchema: ContractSchema<
  GetStorageUsageResult
> = defineContractSchema(
  "GetStorageUsageResult",
  {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "storage"],
        properties: {
          kind: { const: "ok" },
          storage: storageUsageSummarySchema.jsonSchema,
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: { kind: { enum: ["not_found", "unavailable"] } },
      },
    ],
  },
  (value, path) => {
    const object = strictObject(value, path, ["kind", "storage"]);
    const kind = enumValue(
      required(object, "kind", path),
      `${path}.kind`,
      ["ok", "not_found", "unavailable"] as const,
    );
    if (kind !== "ok") {
      strictObject(value, path, ["kind"]);
      return { kind };
    }
    return {
      kind,
      storage: storageUsageSummarySchema.parse(
        required(object, "storage", path),
      ),
    };
  },
);
