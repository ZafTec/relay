import {
  arrayValue,
  booleanValue,
  type ContractSchema,
  defineContractSchema,
  enumValue,
  integerValue,
  isoTimestamp,
  type JsonValue,
  jsonValue,
  nullable,
  optional,
  optionalNullable,
  required,
  strictObject,
  stringValue,
  validationError,
} from "./schema.ts";
import {
  createCursorPageSchema,
  type CursorPage,
  type CursorPaginationRequest,
  cursorPaginationRequestSchema,
} from "./pagination.ts";
import {
  artifactIdParser,
  decimalAmountParser,
  outputSetIdParser,
  runIdParser,
  safeCodeParser,
  toolKeyParser,
  toolVersionIdParser,
  usageReservationIdParser,
} from "./identifiers.ts";
import {
  RUN_RESULT_COMPLETENESS,
  RUN_STATUSES,
  type RunResultCompleteness,
  type RunStatus,
  TERMINAL_RUN_STATUSES,
} from "./statuses.ts";

export const RUN_QUEUE_REASONS = [
  "awaiting_dispatch",
  "capacity_wait",
  "retry_backoff",
] as const;
export type RunQueueReason = (typeof RUN_QUEUE_REASONS)[number];

export interface RunToolReference {
  readonly key: string;
  readonly name: string;
  readonly versionId: string;
  readonly version: number;
}

export interface RunSummary {
  readonly id: string;
  readonly tool: RunToolReference;
  readonly status: RunStatus;
  readonly resultCompleteness: RunResultCompleteness | null;
  readonly acceptedAt: string;
  readonly startedAt: string | null;
  readonly terminalAt: string | null;
}

export interface RunOutputItem {
  readonly ordinal: number;
  readonly name: string;
  readonly status: "pending" | "succeeded" | "failed";
  readonly artifactId: string | null;
  readonly artifactVersionId: string | null;
  readonly errorCode: string | null;
}

export interface RunOutputSet {
  readonly id: string;
  readonly requestedCount: number;
  readonly producedCount: number;
  readonly completeness: RunResultCompleteness;
  readonly warnings: readonly JsonValue[];
  readonly items: readonly RunOutputItem[];
}

export interface RunReservationSummary {
  readonly id: string;
  readonly metric: string;
  readonly unit: string;
  readonly amount: string;
  readonly status: "active" | "committed" | "released" | "expired";
  readonly expiresAt: string;
}

export interface RunDetail extends RunSummary {
  readonly input: JsonValue;
  readonly outputSet: RunOutputSet | null;
  readonly reservation: RunReservationSummary | null;
}

export interface CreateRunRequest {
  readonly toolKey: string;
  readonly input: JsonValue;
  readonly requestedModelVersion?: string | null;
}

export interface ListRunsRequest extends CursorPaginationRequest {
  readonly statuses?: readonly RunStatus[];
  readonly toolKey?: string;
  readonly acceptedAfter?: string;
  readonly acceptedBefore?: string;
}

export type CreateRunResult =
  | {
    readonly kind: "accepted";
    readonly run: RunDetail;
    readonly replayed: boolean;
    readonly queueReason: RunQueueReason | null;
  }
  | { readonly kind: "not_found" }
  | { readonly kind: "tool_unavailable" }
  | { readonly kind: "idempotency_conflict" }
  | {
    readonly kind: "queue_full";
    readonly scope: "global_tool" | "workspace_total" | "workspace_tool";
  };

export type ListRunsResult =
  | ({ readonly kind: "ok" } & CursorPage<RunSummary>)
  | { readonly kind: "not_found" };

export type GetRunResult =
  | { readonly kind: "found"; readonly run: RunDetail }
  | { readonly kind: "not_found" };

export type CancelRunResult =
  | {
    readonly kind: "cancelled" | "cancel_requested" | "already_terminal";
    readonly run: RunDetail;
  }
  | { readonly kind: "not_found" };

function runToolReference(value: unknown, path: string): RunToolReference {
  const object = strictObject(value, path, [
    "key",
    "name",
    "versionId",
    "version",
  ]);
  return {
    key: toolKeyParser(required(object, "key", path), `${path}.key`),
    name: stringValue(required(object, "name", path), `${path}.name`, {
      minLength: 1,
      maxLength: 255,
    }),
    versionId: toolVersionIdParser(
      required(object, "versionId", path),
      `${path}.versionId`,
    ),
    version: integerValue(
      required(object, "version", path),
      `${path}.version`,
      { minimum: 1 },
    ),
  };
}

function runSummary(value: unknown, path: string): RunSummary {
  const object = strictObject(value, path, [
    "id",
    "tool",
    "status",
    "resultCompleteness",
    "acceptedAt",
    "startedAt",
    "terminalAt",
  ]);
  return {
    id: runIdParser(required(object, "id", path), `${path}.id`),
    tool: runToolReference(required(object, "tool", path), `${path}.tool`),
    status: enumValue(
      required(object, "status", path),
      `${path}.status`,
      RUN_STATUSES,
    ),
    resultCompleteness: nullable(
      required(object, "resultCompleteness", path),
      `${path}.resultCompleteness`,
      (item, itemPath) => enumValue(item, itemPath, RUN_RESULT_COMPLETENESS),
    ),
    acceptedAt: isoTimestamp(
      required(object, "acceptedAt", path),
      `${path}.acceptedAt`,
    ),
    startedAt: nullable(
      required(object, "startedAt", path),
      `${path}.startedAt`,
      isoTimestamp,
    ),
    terminalAt: nullable(
      required(object, "terminalAt", path),
      `${path}.terminalAt`,
      isoTimestamp,
    ),
  };
}

export const runSummarySchema: ContractSchema<RunSummary> =
  defineContractSchema(
    "RunSummary",
    {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "tool",
        "status",
        "resultCompleteness",
        "acceptedAt",
        "startedAt",
        "terminalAt",
      ],
      properties: {
        id: { type: "string", pattern: "^run_[0-9a-f]{32}$" },
        tool: {
          type: "object",
          additionalProperties: false,
          required: ["key", "name", "versionId", "version"],
          properties: {
            key: { type: "string", minLength: 1, maxLength: 128 },
            name: { type: "string", minLength: 1, maxLength: 255 },
            versionId: { type: "string", pattern: "^tver_[0-9a-f]{32}$" },
            version: { type: "integer", minimum: 1 },
          },
        },
        status: { type: "string", enum: RUN_STATUSES },
        resultCompleteness: {
          anyOf: [
            { type: "string", enum: RUN_RESULT_COMPLETENESS },
            { type: "null" },
          ],
        },
        acceptedAt: { type: "string", format: "date-time" },
        startedAt: { type: ["string", "null"], format: "date-time" },
        terminalAt: { type: ["string", "null"], format: "date-time" },
      },
    },
    runSummary,
  );

export const runOutputItemSchema: ContractSchema<RunOutputItem> =
  defineContractSchema(
    "RunOutputItem",
    {
      type: "object",
      additionalProperties: false,
      required: [
        "ordinal",
        "name",
        "status",
        "artifactId",
        "artifactVersionId",
        "errorCode",
      ],
      properties: {
        ordinal: { type: "integer", minimum: 0 },
        name: { type: "string", minLength: 1, maxLength: 255 },
        status: { enum: ["pending", "succeeded", "failed"] },
        artifactId: { type: ["string", "null"] },
        artifactVersionId: { type: ["string", "null"] },
        errorCode: { type: ["string", "null"] },
      },
    },
    (value, path): RunOutputItem => {
      const object = strictObject(value, path, [
        "ordinal",
        "name",
        "status",
        "artifactId",
        "artifactVersionId",
        "errorCode",
      ]);
      const status = enumValue(
        required(object, "status", path),
        `${path}.status`,
        ["pending", "succeeded", "failed"] as const,
      );
      const artifactId = nullable(
        required(object, "artifactId", path),
        `${path}.artifactId`,
        artifactIdParser,
      );
      const artifactVersionId = nullable(
        required(object, "artifactVersionId", path),
        `${path}.artifactVersionId`,
        (item, itemPath) =>
          stringValue(item, itemPath, {
            minLength: 37,
            maxLength: 37,
            pattern: /^aver_[0-9a-f]{32}$/,
          }),
      );
      const errorCode = nullable(
        required(object, "errorCode", path),
        `${path}.errorCode`,
        safeCodeParser,
      );
      if (
        (status === "succeeded" &&
          (artifactId === null || artifactVersionId === null ||
            errorCode !== null)) ||
        (status === "failed" &&
          (artifactId !== null || artifactVersionId !== null ||
            errorCode === null)) ||
        (status === "pending" &&
          (artifactId !== null || artifactVersionId !== null ||
            errorCode !== null))
      ) {
        validationError(
          path,
          "invalid_value",
          "output item fields do not match its status",
        );
      }
      return {
        ordinal: integerValue(
          required(object, "ordinal", path),
          `${path}.ordinal`,
          { minimum: 0 },
        ),
        name: stringValue(required(object, "name", path), `${path}.name`, {
          minLength: 1,
          maxLength: 255,
        }),
        status,
        artifactId,
        artifactVersionId,
        errorCode,
      };
    },
  );

export const runOutputSetSchema: ContractSchema<RunOutputSet> =
  defineContractSchema(
    "RunOutputSet",
    {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "requestedCount",
        "producedCount",
        "completeness",
        "warnings",
        "items",
      ],
      properties: {
        id: { type: "string", pattern: "^outset_[0-9a-f]{32}$" },
        requestedCount: { type: "integer", minimum: 1 },
        producedCount: { type: "integer", minimum: 0 },
        completeness: { type: "string", enum: RUN_RESULT_COMPLETENESS },
        warnings: { type: "array", maxItems: 100 },
        items: {
          type: "array",
          maxItems: 100,
          items: runOutputItemSchema.jsonSchema,
        },
      },
    },
    (value, path): RunOutputSet => {
      const object = strictObject(value, path, [
        "id",
        "requestedCount",
        "producedCount",
        "completeness",
        "warnings",
        "items",
      ]);
      const requestedCount = integerValue(
        required(object, "requestedCount", path),
        `${path}.requestedCount`,
        { minimum: 1, maximum: 100 },
      );
      const producedCount = integerValue(
        required(object, "producedCount", path),
        `${path}.producedCount`,
        { minimum: 0, maximum: requestedCount },
      );
      return {
        id: outputSetIdParser(required(object, "id", path), `${path}.id`),
        requestedCount,
        producedCount,
        completeness: enumValue(
          required(object, "completeness", path),
          `${path}.completeness`,
          RUN_RESULT_COMPLETENESS,
        ),
        warnings: arrayValue(
          required(object, "warnings", path),
          `${path}.warnings`,
          jsonValue,
          { maxItems: 100 },
        ),
        items: arrayValue(
          required(object, "items", path),
          `${path}.items`,
          (item) => runOutputItemSchema.parse(item),
          { maxItems: 100 },
        ),
      };
    },
  );

export const runReservationSummarySchema: ContractSchema<
  RunReservationSummary
> = defineContractSchema(
  "RunReservationSummary",
  {
    type: "object",
    additionalProperties: false,
    required: ["id", "metric", "unit", "amount", "status", "expiresAt"],
    properties: {
      id: { type: "string", pattern: "^reservation_[0-9a-f]{32}$" },
      metric: { type: "string", minLength: 1, maxLength: 128 },
      unit: { type: "string", minLength: 1, maxLength: 64 },
      amount: {
        type: "string",
        pattern: "^(?:0|[1-9][0-9]{0,28})(?:\\.[0-9]{1,9})?$",
      },
      status: { enum: ["active", "committed", "released", "expired"] },
      expiresAt: { type: "string", format: "date-time" },
    },
  },
  (value, path): RunReservationSummary => {
    const object = strictObject(value, path, [
      "id",
      "metric",
      "unit",
      "amount",
      "status",
      "expiresAt",
    ]);
    return {
      id: usageReservationIdParser(
        required(object, "id", path),
        `${path}.id`,
      ),
      metric: safeCodeParser(
        required(object, "metric", path),
        `${path}.metric`,
      ),
      unit: stringValue(required(object, "unit", path), `${path}.unit`, {
        minLength: 1,
        maxLength: 64,
      }),
      amount: decimalAmountParser(
        required(object, "amount", path),
        `${path}.amount`,
      ),
      status: enumValue(
        required(object, "status", path),
        `${path}.status`,
        ["active", "committed", "released", "expired"] as const,
      ),
      expiresAt: isoTimestamp(
        required(object, "expiresAt", path),
        `${path}.expiresAt`,
      ),
    };
  },
);

export const runDetailSchema: ContractSchema<RunDetail> = defineContractSchema(
  "RunDetail",
  {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "tool",
      "status",
      "resultCompleteness",
      "acceptedAt",
      "startedAt",
      "terminalAt",
      "input",
      "outputSet",
      "reservation",
    ],
    properties: {
      ...(runSummarySchema.jsonSchema.properties as Record<string, unknown>),
      input: {},
      outputSet: { anyOf: [runOutputSetSchema.jsonSchema, { type: "null" }] },
      reservation: {
        anyOf: [runReservationSummarySchema.jsonSchema, { type: "null" }],
      },
    },
  },
  (value, path): RunDetail => {
    const object = strictObject(value, path, [
      "id",
      "tool",
      "status",
      "resultCompleteness",
      "acceptedAt",
      "startedAt",
      "terminalAt",
      "input",
      "outputSet",
      "reservation",
    ]);
    const summary = runSummary(
      {
        id: object.id,
        tool: object.tool,
        status: object.status,
        resultCompleteness: object.resultCompleteness,
        acceptedAt: object.acceptedAt,
        startedAt: object.startedAt,
        terminalAt: object.terminalAt,
      },
      path,
    );
    return {
      ...summary,
      input: jsonValue(required(object, "input", path), `${path}.input`),
      outputSet: nullable(
        required(object, "outputSet", path),
        `${path}.outputSet`,
        (item) => runOutputSetSchema.parse(item),
      ),
      reservation: nullable(
        required(object, "reservation", path),
        `${path}.reservation`,
        (item) => runReservationSummarySchema.parse(item),
      ),
    };
  },
);

export const createRunRequestSchema: ContractSchema<CreateRunRequest> =
  defineContractSchema(
    "CreateRunRequest",
    {
      type: "object",
      additionalProperties: false,
      required: ["toolKey", "input"],
      properties: {
        toolKey: { type: "string", minLength: 1, maxLength: 128 },
        input: {},
        requestedModelVersion: { type: ["string", "null"], maxLength: 128 },
      },
    },
    (value, path): CreateRunRequest => {
      const object = strictObject(value, path, [
        "toolKey",
        "input",
        "requestedModelVersion",
      ]);
      const requestedModelVersion = optionalNullable(
        object,
        "requestedModelVersion",
        path,
        (item, itemPath) =>
          stringValue(item, itemPath, { minLength: 1, maxLength: 128 }),
      );
      return {
        toolKey: toolKeyParser(
          required(object, "toolKey", path),
          `${path}.toolKey`,
        ),
        input: jsonValue(required(object, "input", path), `${path}.input`),
        ...(requestedModelVersion === undefined
          ? {}
          : { requestedModelVersion }),
      };
    },
  );

export const listRunsRequestSchema: ContractSchema<ListRunsRequest> =
  defineContractSchema(
    "ListRunsRequest",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...(cursorPaginationRequestSchema.jsonSchema.properties as Record<
          string,
          unknown
        >),
        statuses: {
          type: "array",
          uniqueItems: true,
          minItems: 1,
          maxItems: RUN_STATUSES.length,
          items: { type: "string", enum: RUN_STATUSES },
        },
        toolKey: { type: "string", minLength: 1, maxLength: 128 },
        acceptedAfter: { type: "string", format: "date-time" },
        acceptedBefore: { type: "string", format: "date-time" },
      },
    },
    (value, path): ListRunsRequest => {
      const object = strictObject(value, path, [
        "cursor",
        "limit",
        "statuses",
        "toolKey",
        "acceptedAfter",
        "acceptedBefore",
      ]);
      const page = cursorPaginationRequestSchema.parse({
        ...(Object.hasOwn(object, "cursor") ? { cursor: object.cursor } : {}),
        ...(Object.hasOwn(object, "limit") ? { limit: object.limit } : {}),
      });
      const statuses = optional(object, "statuses", path, (item, itemPath) => {
        const parsed = arrayValue(
          item,
          itemPath,
          (status, statusPath) => enumValue(status, statusPath, RUN_STATUSES),
          { minItems: 1, maxItems: RUN_STATUSES.length },
        );
        if (new Set(parsed).size !== parsed.length) {
          validationError(
            itemPath,
            "invalid_value",
            "must not contain duplicates",
          );
        }
        return parsed;
      });
      const toolKey = optional(object, "toolKey", path, toolKeyParser);
      const acceptedAfter = optional(
        object,
        "acceptedAfter",
        path,
        isoTimestamp,
      );
      const acceptedBefore = optional(
        object,
        "acceptedBefore",
        path,
        isoTimestamp,
      );
      if (
        acceptedAfter !== undefined && acceptedBefore !== undefined &&
        acceptedAfter >= acceptedBefore
      ) {
        validationError(
          path,
          "invalid_value",
          "acceptedAfter must precede acceptedBefore",
        );
      }
      return {
        ...page,
        ...(statuses === undefined ? {} : { statuses }),
        ...(toolKey === undefined ? {} : { toolKey }),
        ...(acceptedAfter === undefined ? {} : { acceptedAfter }),
        ...(acceptedBefore === undefined ? {} : { acceptedBefore }),
      };
    },
  );

const runPageSchema: ContractSchema<CursorPage<RunSummary>> =
  createCursorPageSchema(runSummarySchema);

export const createRunResultSchema: ContractSchema<CreateRunResult> =
  defineContractSchema(
    "CreateRunResult",
    {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "run", "replayed", "queueReason"],
          properties: {
            kind: { const: "accepted" },
            run: runDetailSchema.jsonSchema,
            replayed: { type: "boolean" },
            queueReason: {
              anyOf: [
                { type: "string", enum: RUN_QUEUE_REASONS },
                { type: "null" },
              ],
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: {
            kind: {
              enum: [
                "not_found",
                "tool_unavailable",
                "idempotency_conflict",
              ],
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "scope"],
          properties: {
            kind: { const: "queue_full" },
            scope: {
              enum: ["global_tool", "workspace_total", "workspace_tool"],
            },
          },
        },
      ],
    },
    (value, path): CreateRunResult => {
      const object = strictObject(value, path, [
        "kind",
        "run",
        "replayed",
        "queueReason",
        "scope",
      ]);
      const kind = enumValue(
        required(object, "kind", path),
        `${path}.kind`,
        [
          "accepted",
          "not_found",
          "tool_unavailable",
          "idempotency_conflict",
          "queue_full",
        ] as const,
      );
      if (kind === "accepted") {
        strictObject(value, path, ["kind", "run", "replayed", "queueReason"]);
        return {
          kind,
          run: runDetailSchema.parse(required(object, "run", path)),
          replayed: booleanValue(
            required(object, "replayed", path),
            `${path}.replayed`,
          ),
          queueReason: nullable(
            required(object, "queueReason", path),
            `${path}.queueReason`,
            (item, itemPath) => enumValue(item, itemPath, RUN_QUEUE_REASONS),
          ),
        };
      }
      if (kind === "queue_full") {
        strictObject(value, path, ["kind", "scope"]);
        return {
          kind,
          scope: enumValue(
            required(object, "scope", path),
            `${path}.scope`,
            ["global_tool", "workspace_total", "workspace_tool"] as const,
          ),
        };
      }
      strictObject(value, path, ["kind"]);
      return { kind };
    },
  );

export const listRunsResultSchema: ContractSchema<ListRunsResult> =
  defineContractSchema(
    "ListRunsResult",
    {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "items", "nextCursor"],
          properties: {
            kind: { const: "ok" },
            ...(runPageSchema.jsonSchema.properties as Record<string, unknown>),
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
    (value, path): ListRunsResult => {
      const object = strictObject(value, path, ["kind", "items", "nextCursor"]);
      const kind = enumValue(
        required(object, "kind", path),
        `${path}.kind`,
        ["ok", "not_found"] as const,
      );
      if (kind === "not_found") {
        strictObject(value, path, ["kind"]);
        return { kind };
      }
      const page = runPageSchema.parse({
        items: required(object, "items", path),
        nextCursor: required(object, "nextCursor", path),
      });
      return { kind, ...page };
    },
  );

export const getRunResultSchema: ContractSchema<GetRunResult> =
  defineContractSchema(
    "GetRunResult",
    {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "run"],
          properties: {
            kind: { const: "found" },
            run: runDetailSchema.jsonSchema,
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
    (value, path): GetRunResult => {
      const object = strictObject(value, path, ["kind", "run"]);
      const kind = enumValue(
        required(object, "kind", path),
        `${path}.kind`,
        ["found", "not_found"] as const,
      );
      if (kind === "not_found") {
        strictObject(value, path, ["kind"]);
        return { kind };
      }
      return {
        kind,
        run: runDetailSchema.parse(required(object, "run", path)),
      };
    },
  );

export const cancelRunResultSchema: ContractSchema<CancelRunResult> =
  defineContractSchema(
    "CancelRunResult",
    {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "run"],
          properties: {
            kind: { const: "cancelled" },
            run: {
              allOf: [
                runDetailSchema.jsonSchema,
                {
                  type: "object",
                  properties: { status: { const: "cancelled" } },
                },
              ],
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "run"],
          properties: {
            kind: { const: "cancel_requested" },
            run: {
              allOf: [
                runDetailSchema.jsonSchema,
                {
                  type: "object",
                  properties: { status: { const: "cancel_requested" } },
                },
              ],
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "run"],
          properties: {
            kind: { const: "already_terminal" },
            run: {
              allOf: [
                runDetailSchema.jsonSchema,
                {
                  type: "object",
                  properties: {
                    status: { type: "string", enum: TERMINAL_RUN_STATUSES },
                  },
                },
              ],
            },
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
    (value, path): CancelRunResult => {
      const object = strictObject(value, path, ["kind", "run"]);
      const kind = enumValue(
        required(object, "kind", path),
        `${path}.kind`,
        [
          "cancelled",
          "cancel_requested",
          "already_terminal",
          "not_found",
        ] as const,
      );
      if (kind === "not_found") {
        strictObject(value, path, ["kind"]);
        return { kind };
      }
      const run = runDetailSchema.parse(required(object, "run", path));
      const validStatus = kind === "cancelled"
        ? run.status === "cancelled"
        : kind === "cancel_requested"
        ? run.status === "cancel_requested"
        : TERMINAL_RUN_STATUSES.some((status) => status === run.status);
      if (!validStatus) {
        validationError(
          `${path}.run.status`,
          "invalid_value",
          `does not match cancellation result kind ${kind}`,
        );
      }
      return { kind, run };
    },
  );
