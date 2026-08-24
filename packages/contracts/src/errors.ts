import {
  booleanValue,
  type ContractSchema,
  defineContractSchema,
  enumValue,
  integerValue,
  jsonObject,
  optional,
  required,
  strictObject,
  stringValue,
  validationError,
} from "./schema.ts";
import {
  decimalAmountParser,
  safeCodeParser,
  toolKeyParser,
} from "./identifiers.ts";

export const ERROR_CODES = [
  "invalid_request",
  "authentication_required",
  "not_found",
  "idempotency_conflict",
  "not_entitled",
  "allowance_exceeded",
  "tool_unavailable",
  "tool_queue_full",
  "rate_limited",
  "upload_quota_exceeded",
  "upload_verification_failed",
  "dependency_unavailable",
  "internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface PublicErrorDetails {
  readonly field?: string;
  readonly resource?:
    | "workspace"
    | "tool"
    | "run"
    | "artifact"
    | "upload"
    | "share_link";
  readonly reason?: string;
  readonly scope?: "global_tool" | "workspace_total" | "workspace_tool";
  readonly metric?: string;
  readonly unit?: string;
  readonly limitAmount?: string;
  readonly consumedAmount?: string;
  readonly reservedAmount?: string;
  readonly requestedAmount?: string;
  readonly toolKey?: string;
  readonly dependency?: string;
}

export interface PublicError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly requestId: string;
  readonly details: PublicErrorDetails;
}

export interface ErrorEnvelope {
  readonly error: PublicError;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const RAW_URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\//i;

const ERROR_DETAIL_KEYS: Readonly<Record<ErrorCode, readonly string[]>> = {
  invalid_request: ["field", "reason"],
  authentication_required: [],
  not_found: ["resource"],
  idempotency_conflict: [],
  not_entitled: ["metric"],
  allowance_exceeded: [
    "metric",
    "unit",
    "limitAmount",
    "consumedAmount",
    "reservedAmount",
    "requestedAmount",
  ],
  tool_unavailable: ["toolKey", "reason"],
  tool_queue_full: ["scope"],
  rate_limited: [],
  upload_quota_exceeded: [],
  upload_verification_failed: ["reason"],
  dependency_unavailable: ["dependency"],
  internal_error: [],
};

function errorDetails(
  value: unknown,
  path: string,
  code: ErrorCode,
): PublicErrorDetails {
  const safe = jsonObject(value, path, {
    rejectUrls: true,
    maxBytes: 16 * 1024,
  });
  const object = strictObject(safe, path, ERROR_DETAIL_KEYS[code]);
  const result: Record<string, string> = {};
  for (const key of ERROR_DETAIL_KEYS[code]) {
    if (!Object.hasOwn(object, key)) continue;
    const itemPath = `${path}.${key}`;
    switch (key) {
      case "resource":
        result[key] = enumValue(
          object[key],
          itemPath,
          [
            "workspace",
            "tool",
            "run",
            "artifact",
            "upload",
            "share_link",
          ] as const,
        );
        break;
      case "scope":
        result[key] = enumValue(
          object[key],
          itemPath,
          [
            "global_tool",
            "workspace_total",
            "workspace_tool",
          ] as const,
        );
        break;
      case "limitAmount":
      case "consumedAmount":
      case "reservedAmount":
      case "requestedAmount":
        result[key] = decimalAmountParser(object[key], itemPath);
        break;
      case "metric":
      case "unit":
      case "reason":
      case "dependency":
        result[key] = safeCodeParser(object[key], itemPath);
        break;
      case "toolKey":
        result[key] = toolKeyParser(object[key], itemPath);
        break;
      case "field":
        result[key] = stringValue(object[key], itemPath, {
          minLength: 1,
          maxLength: 128,
        });
        break;
    }
  }
  return result;
}

export const publicErrorSchema: ContractSchema<PublicError> =
  defineContractSchema(
    "PublicError",
    {
      type: "object",
      additionalProperties: false,
      required: ["code", "message", "retryable", "requestId", "details"],
      properties: {
        code: { type: "string", enum: ERROR_CODES },
        message: { type: "string", minLength: 1, maxLength: 512 },
        retryable: { type: "boolean" },
        retryAfterSeconds: { type: "integer", minimum: 1, maximum: 86_400 },
        requestId: {
          type: "string",
          minLength: 8,
          maxLength: 128,
          pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]+$",
        },
        details: {
          type: "object",
          additionalProperties: false,
          properties: {
            field: { type: "string", minLength: 1, maxLength: 128 },
            resource: {
              enum: [
                "workspace",
                "tool",
                "run",
                "artifact",
                "upload",
                "share_link",
              ],
            },
            reason: { type: "string", minLength: 1, maxLength: 128 },
            scope: {
              enum: ["global_tool", "workspace_total", "workspace_tool"],
            },
            metric: { type: "string", minLength: 1, maxLength: 128 },
            unit: { type: "string", minLength: 1, maxLength: 128 },
            limitAmount: { type: "string" },
            consumedAmount: { type: "string" },
            reservedAmount: { type: "string" },
            requestedAmount: { type: "string" },
            toolKey: { type: "string", minLength: 1, maxLength: 128 },
            dependency: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    (value, path): PublicError => {
      const object = strictObject(value, path, [
        "code",
        "message",
        "retryable",
        "retryAfterSeconds",
        "requestId",
        "details",
      ]);
      const code = enumValue(
        required(object, "code", path),
        `${path}.code`,
        ERROR_CODES,
      );
      const retryAfterSeconds = optional(
        object,
        "retryAfterSeconds",
        path,
        (item, itemPath) =>
          integerValue(item, itemPath, { minimum: 1, maximum: 86_400 }),
      );
      const message = stringValue(
        required(object, "message", path),
        `${path}.message`,
        { minLength: 1, maxLength: 512 },
      );
      if (RAW_URL_PATTERN.test(message)) {
        validationError(
          `${path}.message`,
          "invalid_value",
          "must not contain a URL",
        );
      }
      const retryable = booleanValue(
        required(object, "retryable", path),
        `${path}.retryable`,
      );
      if (!retryable && retryAfterSeconds !== undefined) {
        validationError(
          `${path}.retryAfterSeconds`,
          "invalid_value",
          "is only valid for retryable errors",
        );
      }
      return {
        code,
        message,
        retryable,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        requestId: stringValue(
          required(object, "requestId", path),
          `${path}.requestId`,
          { minLength: 8, maxLength: 128, pattern: REQUEST_ID_PATTERN },
        ),
        // Details are code-specific and URLs are rejected because they can
        // carry credentials or signatures.
        details: errorDetails(
          required(object, "details", path),
          `${path}.details`,
          code,
        ),
      };
    },
  );

export const errorEnvelopeSchema: ContractSchema<ErrorEnvelope> =
  defineContractSchema(
    "ErrorEnvelope",
    {
      type: "object",
      additionalProperties: false,
      required: ["error"],
      properties: { error: publicErrorSchema.jsonSchema },
    },
    (value, path): ErrorEnvelope => {
      const object = strictObject(value, path, ["error"]);
      return {
        error: publicErrorSchema.parse(required(object, "error", path)),
      };
    },
  );
