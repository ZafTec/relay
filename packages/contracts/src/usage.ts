import {
  arrayValue,
  booleanValue,
  type ContractSchema,
  defineContractSchema,
  enumValue,
  isoTimestamp,
  optional,
  required,
  strictObject,
  validationError,
} from "./schema.ts";
import { decimalAmountParser, safeCodeParser } from "./identifiers.ts";

export const USAGE_PERIODS = [
  "calendar_day",
  "calendar_month",
  "lifetime",
] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

export interface UsageSummaryRequest {
  readonly metric?: string;
  readonly period?: UsagePeriod;
}

export interface UsageSummaryItem {
  readonly metric: string;
  readonly unit: string;
  readonly period: UsagePeriod;
  readonly periodStartsAt: string;
  readonly periodEndsAt: string;
  readonly consumedAmount: string;
  readonly reservedAmount: string;
}

export interface UsageSummary {
  readonly generatedAt: string;
  readonly items: readonly UsageSummaryItem[];
  /** True when the bounded response omitted additional metric dimensions. */
  readonly truncated: boolean;
}

export type GetUsageSummaryResult =
  | { readonly kind: "ok"; readonly usage: UsageSummary }
  | { readonly kind: "not_found" };

export const usageSummaryRequestSchema: ContractSchema<UsageSummaryRequest> =
  defineContractSchema(
    "UsageSummaryRequest",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        metric: { type: "string", minLength: 1, maxLength: 128 },
        period: { type: "string", enum: USAGE_PERIODS },
      },
    },
    (value, path): UsageSummaryRequest => {
      const object = strictObject(value, path, ["metric", "period"]);
      const metric = optional(object, "metric", path, safeCodeParser);
      const period = optional(
        object,
        "period",
        path,
        (item, itemPath) => enumValue(item, itemPath, USAGE_PERIODS),
      );
      return {
        ...(metric === undefined ? {} : { metric }),
        ...(period === undefined ? {} : { period }),
      };
    },
  );

export const usageSummaryItemSchema: ContractSchema<UsageSummaryItem> =
  defineContractSchema(
    "UsageSummaryItem",
    {
      type: "object",
      additionalProperties: false,
      required: [
        "metric",
        "unit",
        "period",
        "periodStartsAt",
        "periodEndsAt",
        "consumedAmount",
        "reservedAmount",
      ],
      properties: {
        metric: { type: "string", minLength: 1, maxLength: 128 },
        unit: { type: "string", minLength: 1, maxLength: 128 },
        period: { type: "string", enum: USAGE_PERIODS },
        periodStartsAt: { type: "string", format: "date-time" },
        periodEndsAt: { type: "string", format: "date-time" },
        consumedAmount: { type: "string" },
        reservedAmount: { type: "string" },
      },
    },
    (value, path): UsageSummaryItem => {
      const object = strictObject(value, path, [
        "metric",
        "unit",
        "period",
        "periodStartsAt",
        "periodEndsAt",
        "consumedAmount",
        "reservedAmount",
      ]);
      const periodStartsAt = isoTimestamp(
        required(object, "periodStartsAt", path),
        `${path}.periodStartsAt`,
      );
      const periodEndsAt = isoTimestamp(
        required(object, "periodEndsAt", path),
        `${path}.periodEndsAt`,
      );
      if (periodStartsAt >= periodEndsAt) {
        validationError(
          path,
          "invalid_value",
          "periodStartsAt must precede periodEndsAt",
        );
      }
      return {
        metric: safeCodeParser(
          required(object, "metric", path),
          `${path}.metric`,
        ),
        unit: safeCodeParser(required(object, "unit", path), `${path}.unit`),
        period: enumValue(
          required(object, "period", path),
          `${path}.period`,
          USAGE_PERIODS,
        ),
        periodStartsAt,
        periodEndsAt,
        consumedAmount: decimalAmountParser(
          required(object, "consumedAmount", path),
          `${path}.consumedAmount`,
        ),
        reservedAmount: decimalAmountParser(
          required(object, "reservedAmount", path),
          `${path}.reservedAmount`,
        ),
      };
    },
  );

export const usageSummarySchema: ContractSchema<UsageSummary> =
  defineContractSchema(
    "UsageSummary",
    {
      type: "object",
      additionalProperties: false,
      required: ["generatedAt", "items", "truncated"],
      properties: {
        generatedAt: { type: "string", format: "date-time" },
        items: {
          type: "array",
          maxItems: 100,
          items: usageSummaryItemSchema.jsonSchema,
        },
        truncated: { type: "boolean" },
      },
    },
    (value, path): UsageSummary => {
      const object = strictObject(value, path, [
        "generatedAt",
        "items",
        "truncated",
      ]);
      return {
        generatedAt: isoTimestamp(
          required(object, "generatedAt", path),
          `${path}.generatedAt`,
        ),
        items: arrayValue(
          required(object, "items", path),
          `${path}.items`,
          (item) => usageSummaryItemSchema.parse(item),
          { maxItems: 100 },
        ),
        truncated: booleanValue(
          required(object, "truncated", path),
          `${path}.truncated`,
        ),
      };
    },
  );

export const getUsageSummaryResultSchema: ContractSchema<
  GetUsageSummaryResult
> = defineContractSchema(
  "GetUsageSummaryResult",
  {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "usage"],
        properties: {
          kind: { const: "ok" },
          usage: usageSummarySchema.jsonSchema,
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: { kind: { const: "not_found" } },
      },
    ],
  },
  (value, path): GetUsageSummaryResult => {
    const object = strictObject(value, path, ["kind", "usage"]);
    const kind = enumValue(
      required(object, "kind", path),
      `${path}.kind`,
      ["ok", "not_found"] as const,
    );
    if (kind === "not_found") {
      strictObject(value, path, ["kind"]);
      return { kind };
    }
    return {
      kind,
      usage: usageSummarySchema.parse(required(object, "usage", path)),
    };
  },
);
